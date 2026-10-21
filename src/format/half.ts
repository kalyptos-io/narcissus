// ieee binary16, the format's opacity

/** the value of every binary16 bit pattern */
const HALF = Float32Array.from({ length: 65536 }, (_, h) => {
	const sign = h & 0x8000 ? -1 : 1;
	const exponent = (h >> 10) & 31;
	const fraction = h & 1023;
	if (exponent === 0) return sign * fraction * 2 ** -24;
	if (exponent === 31) return fraction ? NaN : sign * Infinity;
	return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
});

/** the largest finite positive binary16 */
const MAX = 0x7bff;

export function fromHalf(bits: number): number {
	return HALF[bits];
}

/** the nearest binary16 of v, ties to even; v is clamped to 0 and the largest finite one */
export function toHalf(v: number): number {
	if (!(v > 0)) return 0;
	let lo = 0;
	let hi = MAX;
	// smallest h with HALF[h] >= v
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (HALF[mid] < v) lo = mid + 1;
		else hi = mid;
	}
	if (lo === 0 || HALF[lo] < v) return lo;
	const below = HALF[lo - 1];
	const above = HALF[lo];
	if (v - below < above - v) return lo - 1;
	if (v - below > above - v) return lo;
	return lo & 1 ? lo - 1 : lo;
}
