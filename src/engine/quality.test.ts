import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, pixelRatio, Quality } from './quality.ts';

function frames(q: Quality, ms: number, seconds: number, start = 0) {
	for (let now = start; now <= start + seconds * 1000; now += 16) q.sample(ms, now, true);
}

describe('quality', () => {
	it('uses the requested budget immediately with no ceiling of its own', () => {
		const q = new Quality();
		q.configure(16_000_000);
		expect(q.budget).toBe(16_000_000);
		frames(q, 10, 25);
		expect(q.budget).toBe(16_000_000);
		q.configure(750_000);
		expect(q.budget).toBe(750_000);
	});

	it('adapts resolution without walking the detail budget through levels', () => {
		const q = new Quality();
		q.configure(2_000_000);
		frames(q, 30, 2.5);
		expect(q.scale).toBe(0.85);
		expect(q.budget).toBe(2_000_000);
		frames(q, 30, 8, 3000);
		expect(q.scale).toBe(0.85);
		expect(q.budget).toBe(2_000_000);
		frames(q, 10, 5.5, 12000);
		expect(q.budget).toBe(2_000_000);
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
		expect(q.budget).toBe(2_000_000);
	});

	it('does not undo memory constraints with timing samples or unchanged settings', () => {
		const q = new Quality();
		q.configure(4_000_000);
		q.constrain(1_000_000);
		frames(q, 5, 30);
		q.configure(4_000_000);
		expect(q.budget).toBe(1_000_000);
	});

	it('caps canvas area using its own size and the quality scale', () => {
		const ratio = pixelRatio(3840, 2160, 2, 1);
		expect(3840 * 2160 * ratio ** 2).toBe(MAX_PIXELS);
		expect(pixelRatio(800, 600, 1, 0.5)).toBe(0.5);
	});
});
