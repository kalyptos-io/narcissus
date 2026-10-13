import { describe, expect, it } from 'vitest';
import { readBuffer, testDevice, testFrame } from '../gpu/test-device.ts';
import type { Host, Post } from '../plugin.ts';
import { grade } from './grade.ts';

describe('grade', () => {
	it('runs the clarity curve over every pixel, opaque', async () => {
		const device = await testDevice();
		const posts: Post[] = [];
		const host: Host = {
			shade: () => () => {},
			post: (pass) => {
				posts.push(pass);
				return () => {};
			}
		};
		grade()(host);
		expect(posts.map(({ name }) => name)).toEqual(['grade']);

		const source = device.createTexture({
			size: [1, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
		});
		const grey = new Uint8Array([128, 128, 128, 0]);
		device.queue.writeTexture({ texture: source }, grey, {}, [1, 1]);
		const target = device.createTexture({
			size: [1, 1],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
		});
		const buffer = device.createBuffer({
			size: 256,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
		});
		const pass = posts[0].setup(device, 'rgba8unorm');
		const encoder = device.createCommandEncoder();
		pass.run(encoder, testFrame(), source.createView(), null, target.createView());
		encoder.copyTextureToBuffer({ texture: target }, { buffer }, [1, 1]);
		device.queue.submit([encoder.finish()]);
		const bytes = [...new Uint8Array(await readBuffer(device, buffer, 0, 4))];
		// grey 128 keeps its hue and the curve takes it to 0.491
		[125, 125, 125, 255].forEach((v, i) => expect(Math.abs(bytes[i] - v)).toBeLessThanOrEqual(1));
		pass.destroy();
		source.destroy();
		target.destroy();
		buffer.destroy();
	});
});
