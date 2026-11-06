import { describe, expect, it, vi } from 'vitest';
import { testDevice } from './test-device.ts';
import { Timing } from './timing.ts';

describe('Timing', () => {
	it('resumes timestamp writes after the pending readback finishes', async (context) => {
		const device = await testDevice();
		if (!device.features.has('timestamp-query')) context.skip();
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
	});
});
