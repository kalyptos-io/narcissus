// screen footprint of a box

const ORIGIN = [0, 0, 0] as const;

export interface Footprint {
	/** overlaps the viewport without the fringe */
	shown: boolean;
	/** unclipped projected area in pixels */
	pixels: number;
	/** 1 at the edges up to 16 at the centre */
	weight: number;
}

/** for a screen box in -1..1 coordinates */
export function centreWeight(left: number, right: number, bottom: number, top: number): number {
	const radius =
		(left * left + left * right + right * right + bottom * bottom + bottom * top + top * top) / 3;
	// centre targets quarter-pixel spacing, tapering smoothly to one pixel at the edge
	return 1 + 15 * Math.max(0, 1 - radius) ** 2;
}

/** box shifted by origin into view m; tan is tan(fov / 2), margin widens the viewport */
export function footprint(
	box: ArrayLike<number>,
	m: ArrayLike<number>,
	width: number,
	height: number,
	tan: number,
	near: number,
	far: number,
	margin = 1,
	out: Footprint = { shown: false, pixels: 0, weight: 1 },
	origin: readonly [number, number, number] = ORIGIN
): Footprint {
	const cx = (box[0] + box[3]) / 2 - origin[0];
	const cy = (box[1] + box[4]) / 2 - origin[1];
	const cz = (box[2] + box[5]) / 2 - origin[2];
	const ex = (box[3] - box[0]) / 2;
	const ey = (box[4] - box[1]) / 2;
	const ez = (box[5] - box[2]) / 2;
	const x = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
	const y = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
	const z = -(m[2] * cx + m[6] * cy + m[10] * cz + m[14]);
	const hx = Math.abs(m[0]) * ex + Math.abs(m[4]) * ey + Math.abs(m[8]) * ez;
	const hy = Math.abs(m[1]) * ex + Math.abs(m[5]) * ey + Math.abs(m[9]) * ez;
	const hz = Math.abs(m[2]) * ex + Math.abs(m[6]) * ey + Math.abs(m[10]) * ez;
	out.pixels = 0;
	out.weight = 1;
	out.shown = false;
	if (z + hz < near || z - hz > far) return out;
	const front = Math.max(near, z - hz);
	const back = Math.max(near, z + hz);
	const tx = (tan * width) / height;
	if (Math.abs(x) - hx > margin * tx * back || Math.abs(y) - hy > margin * tan * back) return out;
	const x0 = Math.min((x - hx) / front, (x - hx) / back) / tx;
	const x1 = Math.max((x + hx) / front, (x + hx) / back) / tx;
	const y0 = Math.min((y - hy) / front, (y - hy) / back) / tan;
	const y1 = Math.max((y + hy) / front, (y + hy) / back) / tan;
	if (x1 < -margin || x0 > margin || y1 < -margin || y0 > margin) return out;
	const left = Math.max(-margin, x0);
	const right = Math.min(margin, x1);
	const bottom = Math.max(-margin, y0);
	const top = Math.min(margin, y1);
	const area = (x1 - x0) * (y1 - y0);
	const visibleArea = (right - left) * (top - bottom);
	if (area <= 0 || visibleArea <= 0) return out;
	out.shown = x1 > -1 && x0 < 1 && y1 > -1 && y0 < 1;
	// use unclipped density so a partly visible region keeps the same detail
	out.pixels = (area * width * height) / 4;
	out.weight = centreWeight(left, right, bottom, top);
	return out;
}

const quarter = new Float64Array(6);
const scratch: Footprint = { shown: false, pixels: 0, weight: 1 };

/**
 * bit q set where quadrant q of a page overlaps the viewport: quarter q of its square (x, y, side),
 * within the box; arguments as footprint's
 */
export function shownQuadrants(
	box: ArrayLike<number>,
	[x, y, side]: readonly [number, number, number],
	m: ArrayLike<number>,
	width: number,
	height: number,
	tan: number,
	near: number,
	far: number,
	origin: readonly [number, number, number] = ORIGIN
): number {
	const half = side / 2;
	// splats reach past their quadrant as far as the box reaches past the square
	const pad = Math.max(0, x - box[0], y - box[1], box[3] - x - side, box[4] - y - side);
	quarter[2] = box[2];
	quarter[5] = box[5];
	let mask = 0;
	for (let q = 0; q < 4; q++) {
		const e = x + (q & 1) * half;
		const n = y + (q >> 1) * half;
		quarter[0] = Math.max(box[0], e - pad);
		quarter[1] = Math.max(box[1], n - pad);
		quarter[3] = Math.min(box[3], e + half + pad);
		quarter[4] = Math.min(box[4], n + half + pad);
		if (quarter[0] > quarter[3] || quarter[1] > quarter[4]) continue;
		if (footprint(quarter, m, width, height, tan, near, far, 1, scratch, origin).shown) {
			mask |= 1 << q;
		}
	}
	return mask;
}
