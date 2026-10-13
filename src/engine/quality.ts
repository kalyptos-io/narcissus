export const MIN_BUDGET = 500_000;
export const MAX_PIXELS = 1920 * 1080;
const SCALES = [1, 0.85];

export function pixelRatio(width: number, height: number, ratio: number, scale: number): number {
	return Math.min(ratio, Math.sqrt(MAX_PIXELS / Math.max(1, width * height))) * scale;
}

export function percentile(values: readonly number[], fraction: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * fraction) - 1];
}

export class Quality {
	budget = 2_000_000;
	#scale = 0;
	#ceiling = 2_000_000;
	#samples: { time: number; ms: number }[] = [];
	#last = -Infinity;
	#slow = 0;
	#fast = 0;

	get scale(): number {
		return SCALES[this.#scale];
	}

	configure(requested: number): void {
		const ceiling = Math.max(1, requested);
		if (ceiling !== this.#ceiling) this.budget = ceiling;
		this.#ceiling = ceiling;
	}

	full(): void {
		this.#scale = 0;
		this.reset();
	}

	constrain(budget: number): void {
		this.budget = Math.max(1, Math.min(this.budget, Math.floor(budget)));
		this.reset();
	}

	reset(): void {
		this.#samples = [];
		this.#slow = 0;
		this.#fast = 0;
		this.#last = -Infinity;
	}

	sample(ms: number, now: number, consecutive: boolean): boolean {
		if (!consecutive || now - this.#last > 250 || !Number.isFinite(ms) || ms <= 0) {
			this.reset();
			this.#last = now;
			return false;
		}
		const elapsed = Math.max(0, now - this.#last);
		this.#last = now;
		this.#samples.push({ time: now, ms });
		this.#samples = this.#samples.filter((s) => now - s.time <= 1000);
		if (this.#samples.length < 20) return false;
		const p90 = percentile(
			this.#samples.map((s) => s.ms),
			0.9
		);
		this.#slow = p90 > 20 ? this.#slow + elapsed : 0;
		this.#fast = p90 < 14 ? this.#fast + elapsed : 0;
		if (this.#slow >= 2000) {
			if (this.#scale < SCALES.length - 1) this.#scale++;
			else return false;
		} else if (this.#fast >= 5000) {
			if (this.#scale > 0) this.#scale--;
			else return false;
		} else return false;
		this.reset();
		return true;
	}
}
