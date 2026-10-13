import { describe, expect, it } from 'vitest';
import { Present } from './present.ts';
import { readBuffer, testDevice } from './test-device.ts';

describe('Present', () => {
	it('copies the colour target onto the canvas, opaque', async () => {
		const device = await testDevice();
		const source = device.createTexture({
			size: [2, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
		});
		const texels = new Uint8Array([64, 128, 0, 0, 255, 0, 255, 128]);
		device.queue.writeTexture({ texture: source }, texels, { bytesPerRow: 8 }, [2, 1]);
		const target = device.createTexture({
			size: [2, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
		});
		const buffer = device.createBuffer({
			size: 256,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
		});
		const present = new Present(device, 'rgba8unorm');
		const encoder = device.createCommandEncoder();
		present.encode(encoder, source.createView(), target.createView());
		encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [2, 1]);
		device.queue.submit([encoder.finish()]);
		const bytes = [...new Uint8Array(await readBuffer(device, buffer, 0, 8))];
		expect(bytes).toEqual([64, 128, 0, 255, 255, 0, 255, 255]);
		source.destroy();
		target.destroy();
		buffer.destroy();
	});
});
