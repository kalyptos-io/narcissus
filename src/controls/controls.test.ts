import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../engine/index.ts';
import { Controls, flyAxes, metresPerPixel, smooth } from './controls.ts';
import { cameraOf, type Pose } from './pose.ts';

describe('metresPerPixel', () => {
	it('spans the 45 degree view at the focus over the canvas height', () => {
		expect(metresPerPixel(100, 1000)).toBeCloseTo((200 * Math.tan(Math.PI / 8)) / 1000, 12);
	});

	it('grows with distance and shrinks with taller canvases', () => {
		expect(metresPerPixel(200, 1000)).toBeCloseTo(2 * metresPerPixel(100, 1000), 12);
		expect(metresPerPixel(100, 2000)).toBeCloseTo(metresPerPixel(100, 1000) / 2, 12);
	});

	it('stays finite on a canvas with no height yet', () => {
		expect(Number.isFinite(metresPerPixel(100, 0))).toBe(true);
	});
});

describe('flyAxes', () => {
	const axes = (...codes: string[]) => flyAxes(new Set(codes));

	it('rests with no keys held', () => {
		expect(axes()).toEqual([0, 0, 0]);
	});

	it('maps wasd and arrows to right and forward, q and e to down and up', () => {
		expect(axes('KeyD')).toEqual([1, 0, 0]);
		expect(axes('ArrowLeft')).toEqual([-1, 0, 0]);
		expect(axes('KeyW')).toEqual([0, 1, 0]);
		expect(axes('ArrowDown')).toEqual([0, -1, 0]);
		expect(axes('KeyE')).toEqual([0, 0, 1]);
		expect(axes('KeyQ')).toEqual([0, 0, -1]);
	});

	it('cancels opposite keys and ignores the rest', () => {
		expect(axes('KeyA', 'KeyD', 'KeyW', 'ShiftLeft', 'KeyF')).toEqual([0, 1, 0]);
	});
});

describe('smooth', () => {
	const ground = () => -1000;
	const a: Pose = { e: 0, n: 0, h: 0, yaw: 0, pitch: -35, dist: 300 };
	const b: Pose = { ...a, e: 100 };

	it('closes 63% of the gap in 0.05 s', () => {
		expect(smooth(a, b, 0.05, ground).e).toBeCloseTo(100 * (1 - Math.exp(-1)), 9);
	});

	it('returns the target itself once the rest of the way is invisible', () => {
		const near = { ...b, e: 100 - 1e-6 };
		expect(smooth(near, b, 0.016, ground)).toBe(b);
	});

	it('keeps the camera above the ground while it moves', () => {
		const high = (e: number) => (e > 20 && e < 80 ? 400 : -1000);
		const mid = smooth(a, b, 0.05, high);
		expect(cameraOf(mid).h).toBeGreaterThanOrEqual(high(cameraOf(mid).e) + 10 - 1e-9);
	});
});

describe('Controls', () => {
	const start: Pose = { e: 0, n: 0, h: 0, yaw: 0, pitch: -35, dist: 300 };
	let canvas: EventTarget;
	let tick: (now: number) => void;
	let now: number;
	let controls: Controls;
	const warm = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('window', new EventTarget());
		canvas = Object.assign(new EventTarget(), { clientHeight: 600, setPointerCapture() {} });
		const engine = {
			onFrame: (fn: (now: number) => void) => ((tick = fn), () => {}),
			requestFrame() {},
			setCamera() {},
			warm,
			pick: () => Promise.resolve(null)
		};
		now = 0;
		warm.mockClear();
		controls = new Controls(
			canvas as HTMLCanvasElement,
			engine as unknown as Engine,
			() => 0,
			start
		);
	});

	afterEach(() => {
		controls.destroy();
		vi.unstubAllGlobals();
	});

	const frames = (n: number) => {
		for (let i = 0; i < n; i++) tick((now += 16));
	};
	const event = (type: string, fields: object, prevented = false) => {
		const e = Object.assign(new Event(type, { cancelable: true }), fields);
		if (prevented) e.preventDefault();
		canvas.dispatchEvent(e);
	};
	const drag = (prevented = false) => {
		const pointer = { pointerId: 1, pointerType: 'mouse', buttons: 1 };
		event('pointerdown', { ...pointer, clientX: 0, clientY: 0 }, prevented);
		event('pointermove', { ...pointer, clientX: 50, clientY: 0 }, prevented);
	};
	const wheel = () => event('wheel', { deltaY: 100 });

	it('ignores input while disabled', () => {
		const changed = vi.fn();
		controls.onChange(changed);
		controls.enabled = false;
		drag();
		wheel();
		frames(5);
		expect(controls.pose).toEqual(start);
		expect(changed).not.toHaveBeenCalled();
	});

	it('ignores a pointer a host prevented', () => {
		drag(true);
		frames(5);
		expect(controls.pose).toEqual(start);
	});

	it('heeds a pointer drag otherwise', () => {
		drag();
		frames(5);
		expect(controls.pose.yaw).not.toBe(start.yaw);
		expect(warm).not.toHaveBeenCalled();
	});

	it('flies to the pose and resolves true on arrival', async () => {
		const changed = vi.fn();
		controls.onChange(changed);
		const arrived = controls.flyTo({ e: 500, yaw: 90 });
		frames(200);
		expect(await arrived).toBe(true);
		expect(controls.pose).toMatchObject({ e: 500, n: 0, yaw: 90, dist: 300 });
		expect(changed).toHaveBeenLastCalledWith(controls.pose);
	});

	it('resolves false when the user zooms during a flight', async () => {
		const arrived = controls.flyTo({ e: 500 });
		frames(5);
		wheel();
		frames(200);
		expect(await arrived).toBe(false);
		expect(controls.pose.e).toBeLessThan(500);
	});

	it('resolves false when a new flight starts', async () => {
		const first = controls.flyTo({ e: 500 });
		frames(5);
		const second = controls.flyTo({ n: 500 });
		frames(200);
		expect(await first).toBe(false);
		expect(await second).toBe(true);
	});

	it('resolves false when moveTo moves the camera', async () => {
		const arrived = controls.flyTo({ e: 500 });
		frames(5);
		controls.moveTo(-200, 0);
		expect(await arrived).toBe(false);
	});

	it('resolves false when the signal aborts', async () => {
		const abort = new AbortController();
		const arrived = controls.flyTo({ e: 500 }, { signal: abort.signal });
		frames(5);
		abort.abort();
		expect(await arrived).toBe(false);
	});

	it('jumps at once', () => {
		controls.jump({ e: 40, dist: 100 });
		expect(controls.pose).toEqual({ ...start, e: 40, dist: 100 });
	});
});
