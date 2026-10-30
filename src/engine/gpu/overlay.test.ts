import { describe, expect, it } from 'vitest';
import { perspective, view } from '../math/mat4.ts';
import { FRAME_UNIFORM_BYTES } from './layout.ts';
import { Overlay, type Capsule } from './overlay.ts';
import { DEPTH_FORMAT } from './raster.ts';
import { readBuffer, testDevice } from './test-device.ts';

const SIZE = 64;
const NEAR = 0.5;
const FAR = 300;
const RED = [1, 0, 0, 1] as const;

/** a row of the camera's view: a 2 m line across at northing y, 1 m up */
const line = (y: number, occlude: boolean): Capsule => ({
	a: [-1, y, 1],
	b: [1, y, 1],
	radius: 3,
	colour: RED,
	occlude
});

/** red of the centre texel after the overlay draws capsules over splats 10 m off everywhere */
async function centre(capsules: Capsule[]): Promise<number> {
	const device = await testDevice();
	const uniforms = device.createBuffer({
		size: FRAME_UNIFORM_BYTES,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
	});
	const u = new Float32Array(FRAME_UNIFORM_BYTES / 4);
	u.set(view(new Float32Array(16), [0, 0, 1], 0, 0), 0);
	u.set(perspective(new Float32Array(16), Math.PI / 3, 1, NEAR, FAR), 16);
	u.set([SIZE, SIZE], 76);
	u.set([NEAR, FAR], 80);
	device.queue.writeBuffer(uniforms, 0, u);
	const texture = (format: GPUTextureFormat) =>
		device.createTexture({
			size: [SIZE, SIZE],
			format,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.TEXTURE_BINDING |
				GPUTextureUsage.COPY_SRC
		});
	const target = texture('rgba8unorm');
	const depth = texture(DEPTH_FORMAT);
	const overlay = new Overlay(device, 'rgba8unorm', uniforms);
	overlay.set(capsules, [0, 0, 0]);

	const encoder = device.createCommandEncoder();
	// log-depth span of 10 m, as the raster writes it
	const span = Math.log(10 / NEAR) / Math.log(FAR / NEAR);
	encoder
		.beginRenderPass({
			colorAttachments: [
				{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }
			],
			depthStencilAttachment: {
				view: depth.createView(),
				depthClearValue: span,
				depthLoadOp: 'clear',
				depthStoreOp: 'store'
			}
		})
		.end();
	overlay.encode(encoder, target.createView(), depth.createView());
	const buffer = device.createBuffer({
		size: SIZE * 256,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
	});
	encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [SIZE, SIZE]);
	device.queue.submit([encoder.finish()]);
	const texels = new Uint8Array(await readBuffer(device, buffer));
	overlay.destroy();
	return texels[(SIZE / 2) * 256 + (SIZE / 2) * 4] / 255;
}

describe('Overlay', () => {
	it('draws a line in front of the splats and hides one behind them unless asked not to', async () => {
		expect(await centre([line(5, true)])).toBeCloseTo(1, 2);
		expect(await centre([line(20, true)])).toBe(0);
		expect(await centre([line(20, false)])).toBeCloseTo(1, 2);
		// within the slack a line on the splats' surface still shows
		expect(await centre([line(10.1, true)])).toBeCloseTo(1, 2);
	});

	it('draws a marker as a disc where its ends meet', async () => {
		const marker: Capsule = {
			a: [0, 30, 1],
			b: [0, 30, 1],
			radius: 4,
			colour: RED,
			occlude: false
		};
		expect(await centre([marker])).toBeCloseTo(1, 2);
	});
});
