import { describe, expect, it } from 'vitest';
import { readBuffer, testDevice, testFrame } from '../gpu/test-device.ts';
import type { Host, Post } from '../plugin.ts';
import { dof } from './dof.ts';

// 540 rows give the full blur a radius of 3 px
const [WIDTH, HEIGHT] = [32, 540];
const ROW = HEIGHT / 2;
const [NEAR, FAR, FOCUS] = [1, 1000, 100];

/** red of the middle row after dof over white left of x 16 and black right of it; span(x) is the depth */
async function blur(span: (x: number) => number, strength = 1): Promise<number[]> {
	const device = await testDevice();
	const posts: Post[] = [];
	const host: Host = {
		shade: () => () => {},
		post: (pass) => {
			posts.push(pass);
			return () => {};
		}
	};
	dof(
		() => FOCUS,
		() => strength
	)(host);
	expect(posts.map(({ name, depth }) => [name, depth])).toEqual([['dof', true]]);

	const texture = (format: GPUTextureFormat, usage: number) =>
		device.createTexture({ size: [WIDTH, HEIGHT], format, usage });
	const source = texture('rgba8unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
	const depth = texture('depth16unorm', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
	const target = texture(
		'rgba8unorm',
		GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
	);
	const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
	const spans = new Uint16Array(WIDTH * HEIGHT);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			pixels.fill(x < 16 ? 255 : 0, (y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3);
			pixels[(y * WIDTH + x) * 4 + 3] = 255;
			spans[y * WIDTH + x] = Math.round(span(x) * 0xffff);
		}
	}
	const size = [WIDTH, HEIGHT];
	device.queue.writeTexture({ texture: source }, pixels, { bytesPerRow: WIDTH * 4 }, size);
	device.queue.writeTexture({ texture: depth }, spans, { bytesPerRow: WIDTH * 2 }, size);
	const buffer = device.createBuffer({
		size: 256,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
	});

	const pass = posts[0].setup(device, 'rgba8unorm');
	const encoder = device.createCommandEncoder();
	const frame = testFrame({ width: WIDTH, height: HEIGHT, near: NEAR, far: FAR });
	pass.run(encoder, frame, source.createView(), depth.createView(), target.createView());
	encoder.copyTextureToBuffer({ texture: target, origin: [0, ROW] }, { buffer }, [WIDTH, 1]);
	device.queue.submit([encoder.finish()]);
	const bytes = new Uint8Array(await readBuffer(device, buffer, 0, WIDTH * 4));
	pass.destroy();
	for (const t of [source, depth, target]) t.destroy();
	buffer.destroy();
	return Array.from({ length: WIDTH }, (_, x) => bytes[x * 4]);
}

const white = (from: number, to: number) => Array<number>(to - from).fill(255);
const black = (from: number, to: number) => Array<number>(to - from).fill(0);

describe('dof', () => {
	it('leaves what lies before the focus range sharp', async () => {
		expect(await blur(() => 0)).toEqual([...white(0, 16), ...black(16, 32)]);
	});

	it('blurs what lies past it, by at most the full radius', async () => {
		const red = await blur(() => 1);
		expect(red.slice(0, 12)).toEqual(white(0, 12));
		expect(red.slice(20)).toEqual(black(20, 32));
		expect(red[15]).toBeGreaterThan(0);
		expect(red[15]).toBeLessThan(255);
		expect(red[16]).toBeGreaterThan(0);
		expect(red[16]).toBeLessThan(255);
	});

	it('blurs by a share of the radius at a lower strength, none under half a pixel', async () => {
		expect(await blur(() => 1, 0.15)).toEqual([...white(0, 16), ...black(16, 32)]);
		const red = await blur(() => 1, 0.5);
		expect(red.slice(0, 14)).toEqual(white(0, 14));
		expect(red.slice(18)).toEqual(black(18, 32));
	});

	it('keeps a sharp edge out of the blur behind it, and the blur off the sharp side', async () => {
		const red = await blur((x) => (x < 16 ? 1 : 0));
		expect(red.slice(0, 15)).toEqual(white(0, 15));
		expect(red.slice(16)).toEqual(black(16, 32));
	});
});
