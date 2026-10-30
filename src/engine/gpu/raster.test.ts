import { describe, expect, it } from 'vitest';
import { FRAME_UNIFORM_BYTES, PROJECTED_WORDS, WORK } from './layout.ts';
import { frameBuffers } from './buffers.ts';
import { COLOUR_FORMAT, DEPTH_FORMAT, Raster } from './raster.ts';
import { Sort } from './sort.ts';
import { readBuffer, testDevice } from './test-device.ts';

const SIZE = 32;
const OPACITY = 0.75;
const SIGMA_ALPHA = OPACITY * Math.exp(-0.5);
const SKY = [0, 0, 1] as const;

/** rgba of texel (x, y from the top-left) from rgb10a2unorm, or [depth] from the depth format */
async function texels(device: GPUDevice, texture: GPUTexture) {
	// copies take rows of 256 bytes
	const row = 256;
	const buffer = device.createBuffer({
		size: SIZE * row,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
	});
	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, [SIZE, SIZE]);
	device.queue.submit([encoder.finish()]);
	const data = await readBuffer(device, buffer);
	buffer.destroy();
	if (texture.format === DEPTH_FORMAT) {
		const depths = new Uint16Array(data);
		return (x: number, y: number) => [depths[(y * row) / 2 + x] / 0xffff];
	}
	const words = new Uint32Array(data);
	return (x: number, y: number) => {
		const w = words[(y * row) / 4 + x];
		const channel = (shift: number) => ((w >>> shift) & 1023) / 1023;
		return [channel(0), channel(10), channel(20), (w >>> 30) / 3];
	};
}

/** one splat at 10 m, 3 px sigma, centred on texel (16, 15) */
async function draw(withDepth: boolean) {
	const device = await testDevice();
	const buffers = frameBuffers(device, 4, 1);
	const sort = new Sort(device, buffers);
	const raster = new Raster(device, buffers, sort);

	const uniforms = new Float32Array(FRAME_UNIFORM_BYTES / 4);
	// viewport, then near and far
	uniforms.set([SIZE, SIZE], 76);
	uniforms.set([1, 1000], 80);
	device.queue.writeBuffer(buffers.uniforms, 0, uniforms);
	const splat = new ArrayBuffer(PROJECTED_WORDS * 4);
	new Float32Array(splat, 0, 2).set([16.5, 16.5]);
	// f16 pairs: major (3, 0), minor (0, 3), rg (1, 0.5), b and opacity (0.25, 0.75)
	new Uint32Array(splat, 8, 4).set([0x4200, 0x42000000, 0x38003c00, 0x3a003400]);
	device.queue.writeBuffer(buffers.projected, 0, splat);
	device.queue.writeBuffer(buffers.sort, sort.values, new Uint32Array([0]));
	// 10 m sits a third of the way from near to far in log depth
	const key = Math.round((2 / 3) * 0xffffff);
	device.queue.writeBuffer(buffers.sort, sort.keys, new Uint32Array([key]));
	device.queue.writeBuffer(buffers.work, WORK.drawArgs * 4, new Uint32Array([4, 1, 0, 0]));

	const target = (format: GPUTextureFormat) =>
		device.createTexture({
			size: [SIZE, SIZE],
			format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
		});
	const colour = target(COLOUR_FORMAT);
	const depth = withDepth ? target(DEPTH_FORMAT) : null;
	const encoder = device.createCommandEncoder();
	raster.encode(encoder, colour.createView(), depth?.createView() ?? null, SKY);
	device.queue.submit([encoder.finish()]);
	const result = {
		colour: await texels(device, colour),
		depth: depth ? await texels(device, depth) : null
	};
	colour.destroy();
	depth?.destroy();
	raster.destroy();
	sort.destroy();
	buffers.destroy();
	return result;
}

describe('Raster', () => {
	it('covers the sky with the opacity and falls off by sigma', async () => {
		const { colour } = await draw(false);
		const [r, g, b, a] = colour(16, 15);
		expect(r).toBeCloseTo(OPACITY, 2);
		expect(g).toBeCloseTo(0.5 * OPACITY, 2);
		expect(b).toBeCloseTo(0.25 * OPACITY + SKY[2] * (1 - OPACITY), 2);
		expect(a).toBe(1);
		// red is the splat's alone: one sigma along the major axis, then along the minor, which points up
		expect(colour(19, 15)[0]).toBeCloseTo(SIGMA_ALPHA, 2);
		expect(colour(16, 12)[0]).toBeCloseTo(SIGMA_ALPHA, 2);
		expect(colour(22, 15)[0]).toBeLessThan(colour(19, 15)[0]);
		expect(colour(0, 0)).toEqual([...SKY, 1]);
	});

	it('writes the log-depth span of the splat where it drew, 1 elsewhere, and the same colour', async () => {
		const { colour, depth } = await draw(true);
		const plain = (await draw(false)).colour;
		expect(depth).not.toBeNull();
		for (const x of [16, 19]) {
			expect(depth!(x, 15)[0]).toBeCloseTo(1 / 3, 4);
			expect(colour(x, 15)).toEqual(plain(x, 15));
		}
		expect(depth!(0, 0)).toEqual([1]);
	});
});
