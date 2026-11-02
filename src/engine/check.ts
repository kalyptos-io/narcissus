// range checks of handle fields; each throws a RangeError that starts with what

import type { Colour, Point } from './types.ts';

/** a copy of p, three finite numbers */
export function checkPoint(p: Point, what: string): Point {
	if (p.length !== 3 || !p.every(Number.isFinite)) {
		throw new RangeError(`${what} must be three finite numbers.`);
	}
	return [p[0], p[1], p[2]];
}

export function checkUnit(v: number, what: string): number {
	if (!(v >= 0 && v <= 1)) throw new RangeError(`${what} must be a number from 0 to 1.`);
	return v;
}

export function checkColour(c: Colour, what: string): Colour {
	if (!(c.length === 4 && c.every((v) => v >= 0 && v <= 1))) {
		throw new RangeError(`${what} must be four numbers from 0 to 1.`);
	}
	return c;
}
