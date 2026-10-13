// a real gpu for kernel tests, through dawn's node bindings

import { create, globals } from 'webgpu';
import type { Frame } from '../plugin.ts';

Object.assign(globalThis, globals);

// dawn frees its instance when this is collected, under every device made from it
const gpu = create([]);

let shared: Promise<GPUDevice> | undefined;

/** one device for the whole test run, with the adapter's largest buffers */
export function testDevice(): Promise<GPUDevice> {
	shared ??= (async () => {
		const adapter = await gpu.requestAdapter();
		if (!adapter) throw new Error('No GPU adapter for the kernel tests.');
		return adapter.requestDevice({
			requiredLimits: {
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
				maxBufferSize: adapter.limits.maxBufferSize
			}
		});
	})();
	return shared;
}

/** size bytes of buffer from offset, copied out through a staging buffer */
export async function readBuffer(
	device: GPUDevice,
	buffer: GPUBuffer,
	offset = 0,
	size = buffer.size - offset
): Promise<ArrayBuffer> {
	const staging = device.createBuffer({
		size,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
	});
	const encoder = device.createCommandEncoder();
	encoder.copyBufferToBuffer(buffer, offset, staging, 0, size);
	device.queue.submit([encoder.finish()]);
	await staging.mapAsync(GPUMapMode.READ);
	const copy = staging.getMappedRange().slice(0);
	staging.destroy();
	return copy;
}

/** a 1 x 1 frame with zero matrices, for plugin tests */
export function testFrame(frame: Partial<Frame> = {}): Frame {
	const matrix = new Float32Array(16);
	return {
		time: 0,
		width: 1,
		height: 1,
		view: matrix,
		proj: matrix,
		near: 1,
		far: 1000,
		camera: new Float32Array(3),
		origin: [0, 0, 0],
		...frame
	};
}
