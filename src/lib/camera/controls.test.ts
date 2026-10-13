import { describe, expect, it } from 'vitest';
import { flyAxes, metresPerPixel, smooth } from './controls.ts';
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
