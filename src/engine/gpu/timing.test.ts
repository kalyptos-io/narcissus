import { describe, expect, it } from 'vitest';
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
});
