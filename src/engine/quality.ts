export const MIN_BUDGET = 500_000;
export const MAX_PIXELS = 1920 * 1080;
const SCALES = [1, 0.85];
/** fps under which detail goes, and at which it may come back */
const SLOW_FPS = 30;
const FAST_FPS = 55;
/** ms of slow frames before a step down, and of fast ones before a step up */
const SLOW_MS = 2000;
const FAST_MS = 5000;
/** splats a step up adds */
const STEP = 500_000;
/** share of the budget the plan must take before it grows; a budget not taken would cost only once pages load */
const TAKEN = 0.9;

export function pixelRatio(width: number, height: number, ratio: number, scale: number): number {
	return Math.min(ratio, Math.sqrt(MAX_PIXELS / Math.max(1, width * height))) * scale;
}

export function percentile(values: readonly number[], fraction: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

/** holds SLOW_FPS with the budget first, within range, then the render scale */
export class Quality {
	#scale = 0;
	#budget: number;
	#min: number;
	#max: number;
	#samples: { time: number; ms: number }[] = [];
	#last = -Infinity;
	#slow = 0;
	#fast = 0;

	/** budget alone stays fixed */
	constructor(budget: number, [min, max]: readonly [number, number] = [budget, budget]) {
		this.#min = min;
		this.#max = Math.max(min, max);
		this.#budget = Math.min(this.#max, Math.max(this.#min, budget));
	}

	get scale(): number {
		return SCALES[this.#scale];
	}

	/** splats a frame may draw */
	get budget(): number {
		return this.#budget;
	}

	full(): void {
		this.#scale = 0;
		this.#reset();
	}

	#reset(): void {
		this.#samples = [];
		this.#slow = 0;
		this.#fast = 0;
		this.#last = -Infinity;
	}

	/** ms since the last frame; planned, the splats the plan draws; true when the scale or budget changed */
	sample(ms: number, now: number, consecutive: boolean, planned: number): boolean {
		if (
			!consecutive ||
			now - this.#last > Math.max(250, 2 * ms) ||
			!Number.isFinite(ms) ||
			ms <= 0
		) {
			this.#reset();
			this.#last = now;
			return false;
		}
		const elapsed = Math.max(0, now - this.#last);
		this.#last = now;
		this.#samples.push({ time: now, ms });
		this.#samples = this.#samples.filter((s) => now - s.time <= Math.max(1000, 2 * ms));
		if (now - this.#samples[0].time < 300) return false;
		const mean = this.#samples.reduce((sum, s) => sum + s.ms, 0) / this.#samples.length;
		this.#slow = mean > 1000 / SLOW_FPS ? this.#slow + elapsed : 0;
		this.#fast = mean <= 1000 / FAST_FPS ? this.#fast + elapsed : 0;
		if (this.#slow >= SLOW_MS) {
			// frame time follows the budget, so it shrinks in proportion, by a tenth at least
			const fit = Math.floor(Math.min(0.9, 1000 / SLOW_FPS / mean) * this.#budget);
			if (this.#budget > this.#min) this.#budget = Math.max(this.#min, fit);
			else if (this.#scale < SCALES.length - 1) this.#scale++;
			else return false;
		} else if (this.#fast >= FAST_MS) {
			if (this.#scale > 0) this.#scale--;
			else if (this.#budget < this.#max && planned >= TAKEN * this.#budget) {
				this.#budget = Math.min(this.#max, this.#budget + STEP);
			} else return false;
		} else return false;
		this.#reset();
		return true;
	}
}
