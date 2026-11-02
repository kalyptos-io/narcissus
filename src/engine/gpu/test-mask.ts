// masks for kernel tests

import { edges, type Prism } from '../math/prism.ts';
import type { Spec } from './masks.ts';

/** a mask over the rectangle from (x0, y0) to (x1, y1) that hides the world's splats unless fields say else */
export function rect(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	fields: Partial<Spec & Prism> = {}
): Spec {
	const { z = [-Infinity, Infinity], outside = false, targets = new Set([0]) } = fields;
	const { opacity = 0, tint = [0, 0, 0, 0] } = fields;
	const ring: [number, number][] = [
		[x0, y0],
		[x1, y0],
		[x1, y1],
		[x0, y1]
	];
	return { prism: { edges: edges([ring]), z, outside }, targets, opacity, tint };
}
