import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../engine/index.ts';
import { Controls, flyAxes, metresPerPixel, smooth } from './controls.ts';
import { cameraOf, LIMITS, type Pose } from './pose.ts';

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
		const [e, , h] = cameraOf(mid);
		expect(h).toBeGreaterThanOrEqual(high(e) + 10 - 1e-9);
	});
});

describe('Controls', () => {
	const start: Pose = { e: 0, n: 0, h: 0, yaw: 0, pitch: -35, dist: 300 };
	let canvas: EventTarget & { tabIndex: number };
	let tick: (now: number) => void;
	let now: number;
	let controls: Controls;
	const warm = vi.fn();
	const pick = vi.fn(() => Promise.resolve(null));

	beforeEach(() => {
		vi.stubGlobal('window', new EventTarget());
		canvas = Object.assign(new EventTarget(), {
			clientHeight: 600,
			tabIndex: -1,
			setPointerCapture() {}
		});
		const engine = {
			onFrame: (fn: (now: number) => void) => ((tick = fn), () => {}),
			requestFrame() {},
			setCamera() {},
			warm,
			pick
		};
		now = 0;
		warm.mockClear();
		pick.mockClear();
		controls = new Controls(canvas as unknown as HTMLCanvasElement, engine as unknown as Engine, {
			ground: () => 0,
			pose: start
		});
	});

	afterEach(() => {
		controls.destroy();
		vi.unstubAllGlobals();
	});

	const frames = (n: number) => {
		for (let i = 0; i < n; i++) tick((now += 16));
	};
	const event = (type: string, fields: object, prevented = false, target: EventTarget = canvas) => {
		const e = Object.assign(new Event(type, { cancelable: true }), fields);
		if (prevented) e.preventDefault();
		target.dispatchEvent(e);
	};
	const key = (type: string, code: string, target: EventTarget = canvas) =>
		event(type, { code, repeat: false }, false, target);
	const fly = (target: EventTarget = canvas) => {
		key('keydown', 'KeyF', target);
		key('keydown', 'KeyW', target);
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

	it('makes the canvas focusable', () => {
		expect(canvas.tabIndex).toBe(0);
	});

	it('flies on keys pressed on the canvas', () => {
		fly();
		frames(5);
		expect(controls.pose.n).toBeGreaterThan(start.n);
	});

	it('ignores keys pressed elsewhere', () => {
		fly(window);
		fly(new EventTarget());
		frames(5);
		expect(controls.pose).toEqual(start);
	});

	it('lets go of held keys when the canvas loses focus', () => {
		fly();
		frames(5);
		canvas.dispatchEvent(new Event('blur'));
		frames(100);
		const rest = controls.pose;
		frames(50);
		expect(controls.pose).toEqual(rest);
	});

	it('does not fly to a double click whose pointerdown a host consumed', () => {
		const pointer = { pointerId: 1, pointerType: 'mouse', buttons: 1, clientX: 0, clientY: 0 };
		const click = { offsetX: 10, offsetY: 10 };
		event('pointerdown', pointer, true);
		event('dblclick', click);
		expect(pick).not.toHaveBeenCalled();
		event('pointerdown', pointer);
		event('dblclick', click);
		expect(pick).toHaveBeenCalledOnce();
	});

	it('clamps the pose to new limits and tells the listeners', () => {
		const changed = vi.fn();
		controls.onChange(changed);
		controls.limits = { ...LIMITS, dist: [1, 100] };
		expect(controls.pose.dist).toBe(100);
		expect(controls.limits.dist).toEqual([1, 100]);
		expect(changed).toHaveBeenCalledWith(controls.pose);
		controls.limits = { ...LIMITS, dist: [1, 200] };
		expect(changed).toHaveBeenCalledOnce();
	});

	it('throws on bad limits, naming the field, and keeps the old ones', () => {
		const bad: [string, object][] = [
			['pitch', { pitch: [-20, -90] }],
			['pitch', { pitch: [-100, -20] }],
			['dist', { dist: [0, 100] }],
			['dist', { dist: [1, Infinity] }],
			['clearance', { clearance: NaN }],
			['floor', { floor: -Infinity }]
		];
		for (const [field, wrong] of bad) {
			expect(() => (controls.limits = { ...LIMITS, ...wrong })).toThrow(
				expect.objectContaining({
					name: 'RangeError',
					message: expect.stringContaining(`limits.${field} `)
				})
			);
		}
		expect(controls.limits).toEqual(LIMITS);
	});

	it('jumps at once', () => {
		controls.jump({ e: 40, dist: 100 });
		expect(controls.pose).toEqual({ ...start, e: 40, dist: 100 });
	});
});
