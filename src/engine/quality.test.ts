import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, pixelRatio, Quality } from './quality.ts';

const RANGE = [2_000_000, 6_000_000] as const;

/** frames ms apart for seconds from start, the plan taking planned splats */
function frames(q: Quality, ms: number, seconds: number, start = 0, planned = q.budget) {
	for (let now = start; now <= start + seconds * 1000; now += ms) q.sample(ms, now, true, planned);
	return start + seconds * 1000 + ms;
}

describe('quality', () => {
	it.each([0.5, 1, 2, 4, 8, 15])(
		'lowers the resolution of a fixed budget during sustained rendering at %s fps',
		(fps) => {
			const q = new Quality(4_000_000);
			const interval = 1000 / fps;
			frames(q, interval, Math.max(3, (4 * interval) / 1000));
			expect(q.scale).toBe(0.85);
			expect(q.budget).toBe(4_000_000);
		}
	);

	it('lowers the budget in proportion to the frame rate under 30 fps', () => {
		const q = new Quality(4_000_000, RANGE);
		frames(q, 50, 2.5);
		expect(q.budget).toBe(2_666_666);
		expect(q.scale).toBe(1);
	});

	it('lowers the budget by a tenth at least, and not below the range', () => {
		const q = new Quality(4_000_000, RANGE);
		frames(q, 34, 2.5);
		expect(q.budget).toBe(3_600_000);
		frames(q, 200, 10, 3000);
		expect(q.budget).toBe(2_000_000);
	});

	it('lowers the resolution once the budget is at the floor, and restores it first', () => {
		const q = new Quality(2_000_000, RANGE);
		let now = frames(q, 50, 2.5);
		expect(q.scale).toBe(0.85);
		now = frames(q, 16, 7, now);
		expect(q.scale).toBe(1);
		expect(q.budget).toBe(2_000_000);
		frames(q, 16, 6, now);
		expect(q.budget).toBe(2_500_000);
	});

	it('raises the budget in steps after 5 s at 55 fps, up to the range', () => {
		const q = new Quality(5_000_000, RANGE);
		let now = frames(q, 16, 4.5);
		expect(q.budget).toBe(5_000_000);
		now = frames(q, 16, 1.5, now);
		expect(q.budget).toBe(5_500_000);
		frames(q, 16, 20, now);
		expect(q.budget).toBe(6_000_000);
	});

	it('raises only a budget the plan takes, and holds between 30 and 55 fps', () => {
		const untaken = new Quality(4_000_000, RANGE);
		frames(untaken, 16, 10, 0, 3_000_000);
		expect(untaken.budget).toBe(4_000_000);
		const between = new Quality(4_000_000, RANGE);
		frames(between, 25, 20);
		expect(between.budget).toBe(4_000_000);
		expect(between.scale).toBe(1);
	});

	it('does not adapt from idle gaps, hidden frames, or isolated stalls', () => {
		const q = new Quality(2_000_000);
		for (let i = 0; i < 100; i++) q.sample(100, i * 1000, true, 0);
		for (let i = 0; i < 1000; i++) q.sample(100, 100_000 + i * 16, false, 0);
		frames(q, 10, 1, 200_000);
		q.sample(100, 201_016, true, 0);
		frames(q, 10, 1, 201_032);
		expect(q.scale).toBe(1);
	});

	it('caps canvas area using its own size and the quality scale', () => {
		const ratio = pixelRatio(3840, 2160, 2, 1);
		expect(3840 * 2160 * ratio ** 2).toBe(MAX_PIXELS);
		expect(pixelRatio(800, 600, 1, 0.5)).toBe(0.5);
	});
});
