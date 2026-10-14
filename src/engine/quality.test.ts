import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, pixelRatio, Quality } from './quality.ts';

function frames(q: Quality, ms: number, seconds: number, start = 0) {
	for (let now = start; now <= start + seconds * 1000; now += 16) q.sample(ms, now, true);
}

describe('quality', () => {
	it.each([0.5, 1, 2, 4, 8, 15])(
		'lowers the resolution during sustained rendering at %s fps',
		(fps) => {
			const q = new Quality();
			const interval = 1000 / fps;
			for (let now = 0; now <= Math.max(3000, 4 * interval); now += interval)
				q.sample(interval, now, true);
			expect(q.scale).toBe(0.85);
		}
	);

	it('lowers the resolution under slow frames and restores it under fast ones', () => {
		const q = new Quality();
		frames(q, 30, 2.5);
		expect(q.scale).toBe(0.85);
		frames(q, 30, 8, 3000);
		expect(q.scale).toBe(0.85);
		frames(q, 10, 5.5, 12000);
		expect(q.scale).toBe(1);
	});

	it('does not adapt from idle gaps, hidden frames, or isolated stalls', () => {
		const q = new Quality();
		for (let i = 0; i < 100; i++) q.sample(100, i * 1000, true);
		for (let i = 0; i < 1000; i++) q.sample(100, 100_000 + i * 16, false);
		frames(q, 10, 1, 200_000);
		q.sample(100, 201_016, true);
		frames(q, 10, 1, 201_032);
		expect(q.scale).toBe(1);
	});

	it('caps canvas area using its own size and the quality scale', () => {
		const ratio = pixelRatio(3840, 2160, 2, 1);
		expect(3840 * 2160 * ratio ** 2).toBe(MAX_PIXELS);
		expect(pixelRatio(800, 600, 1, 0.5)).toBe(0.5);
	});
});
