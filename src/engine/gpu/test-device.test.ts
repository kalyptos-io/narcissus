import { describe, expect, it } from 'vitest';
import { readBuffer, testDevice } from './test-device.ts';

describe('testDevice', () => {
	it('runs a compute shader on the real gpu', async () => {
		const device = await testDevice();
		const buffer = device.createBuffer({
			size: 16,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		});
		const module = device.createShaderModule({
			code: `@group(0) @binding(0) var<storage, read_write> out: array<u32, 4>;
@compute @workgroup_size(4) fn main(@builtin(local_invocation_index) i: u32) { out[i] = i * 7u; }`
		});
		const pipeline = device.createComputePipeline({
			layout: 'auto',
			compute: { module, entryPoint: 'main' }
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(
			0,
			device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [{ binding: 0, resource: { buffer } }]
			})
		);
		pass.dispatchWorkgroups(1);
		pass.end();
		device.queue.submit([encoder.finish()]);
		expect([...new Uint32Array(await readBuffer(device, buffer))]).toEqual([0, 7, 14, 21]);
	});
});
