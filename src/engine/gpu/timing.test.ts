import { describe, expect, it, vi } from 'vitest';
import { create } from 'webgpu';
import { testDevice } from './test-device.ts';
import { Timing } from './timing.ts';

describe('Timing', () => {
	it('stays inert when disabled', async () => {
		const device = await testDevice();
		const timing = new Timing(device, false, ['cull', 'raster']);
		expect(timing.writes('cull')).toBeUndefined();
		const encoder = device.createCommandEncoder();
		timing.resolve(encoder);
		device.queue.submit([encoder.finish()]);
		timing.read();
		await device.queue.onSubmittedWorkDone();
		expect(timing.ms).toEqual({});
		timing.destroy();
	});

	it('resumes timestamp writes after the pending readback finishes', async (context) => {
		const gpu = create([]);
		const adapter = await gpu.requestAdapter();
		if (!adapter?.features.has('timestamp-query')) context.skip();
		const device = await adapter!.requestDevice({ requiredFeatures: ['timestamp-query'] });
		const timing = new Timing(device, true, ['empty']);
		const encoder = device.createCommandEncoder();
		encoder.beginComputePass({ timestampWrites: timing.writes('empty') }).end();
		timing.resolve(encoder);
		device.queue.submit([encoder.finish()]);
		timing.read();
		expect(timing.writes('empty')).toBeUndefined();
		await device.queue.onSubmittedWorkDone();
		await vi.waitFor(() => expect(timing.writes('empty')).toBeDefined());
		expect(timing.ms.empty).toBeGreaterThanOrEqual(0);
		timing.destroy();
		device.destroy();
	});
});
