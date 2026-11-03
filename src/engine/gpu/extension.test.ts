import { describe, expect, it } from 'vitest';
import { Extension } from './extension.ts';
import { readBuffer, testDevice } from './test-device.ts';

const words = async (device: GPUDevice, extension: Extension) =>
	new Uint32Array(await readBuffer(device, extension.buffer));

describe('Extension', () => {
	it('takes the first free block that fits, and joins freed neighbours', async () => {
		const extension = new Extension(await testDevice(), 64);
		const [a, b, c] = [extension.alloc(4), extension.alloc(4), extension.alloc(4)];
		expect([a, b, c]).toEqual([0, 4, 8]);
		extension.free(a);
		expect(extension.alloc(2)).toBe(0);
		extension.free(b);
		// 2 to 8 is free now: 2 words left of a, and all of b
		expect(extension.alloc(6)).toBe(2);
		extension.free(c);
		expect(extension.alloc(1)).toBe(8);
		extension.destroy();
	});

	it('uploads writes at flush, and grows keeping what it held', async () => {
		const device = await testDevice();
		const extension = new Extension(device, 4);
		const first = extension.alloc(4);
		extension.write(first, Uint32Array.of(1, 2, 3, 4));
		extension.flush();
		const old = extension.buffer;
		const second = extension.alloc(5);
		extension.write(second, Uint32Array.of(5, 6, 7, 8, 9));
		extension.flush();
		const grown = extension.buffer;
		expect(grown).not.toBe(old);
		expect(grown.size).toBe(4 * 9);
		expect([...(await words(device, extension))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		extension.flush();
		expect(extension.buffer).toBe(grown);
		extension.destroy();
	});

	it('keeps the frame region while a frame asks for no more, and moves it when one does', async () => {
		const extension = new Extension(await testDevice(), 64);
		const at = extension.frame(8);
		expect(extension.frame(8)).toBe(at);
		expect(extension.frame(3)).toBe(at);
		const fixed = extension.alloc(2);
		const moved = extension.frame(9);
		expect(moved).not.toBe(at);
		expect(fixed).not.toBe(moved);
		// the old region is free again
		expect(extension.alloc(8)).toBe(at);
		extension.destroy();
	});
});
