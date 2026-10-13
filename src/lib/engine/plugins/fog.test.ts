import { describe, expect, it } from 'vitest';
import common from '../gpu/common.wgsl?raw';
import { testDevice, testFrame } from '../gpu/test-device.ts';
import type { Host, Shade } from '../ports.ts';
import { fog } from './fog.ts';

/** installs fog on a host that records its hook */
async function install() {
	const device = await testDevice();
	const shades: Shade[] = [];
	let removed = false;
	const host: Host = {
		shade: (hook) => {
			shades.push(hook);
			return () => (removed = true);
		},
		post: () => () => {}
	};
	const uninstall = fog([0.5, 0.25, 0.75], 0.25)(host);
	return { device, shade: shades[0], uninstall, removed: () => removed };
}

describe('fog', () => {
	it('fills its colour, start depth and far clip', async () => {
		const { shade, uninstall, removed } = await install();
		expect(shade.name).toBe('fog');
		expect(shade.uniforms).toBe(2);
		const out = new Float32Array(8).fill(9);
		shade.update(testFrame({ far: 2000 }), out);
		expect([...out]).toEqual([0.5, 0.25, 0.75, 500, 2000, 0, 0, 0]);
		uninstall();
		expect(removed()).toBe(true);
	});

	it('compiles over the splat struct', async () => {
		const { device, shade } = await install();
		device.pushErrorScope('validation');
		device.createShaderModule({ code: common + shade.wgsl });
		expect(await device.popErrorScope()).toBeNull();
	});
});
