// .idx fixtures for the tests that grow a tree

import { LEAF, PAGE_SIDE, type Idx, type PageRow, type UnitKey } from '../../format/index.ts';

export function hash({ level, e, n }: UnitKey): string {
	return ((level * 4096 + e / LEAF) * 65536 + n / LEAF).toString(16).padStart(16, '0');
}

export interface UnitOptions {
	/** splats a page */
	count?: number;
	/** page levels above the unit's own */
	extra?: number;
	/** quadrants whose child unit is named */
	children?: number[];
	/** bytes a page, back to back in the pack */
	size?: number;
}

/** a full unit of flat ground: every page present, every descendant named */
export function unit(
	key: UnitKey,
	{ count = 1000, extra = 0, children = [0, 1, 2, 3], size = 0 }: UnitOptions = {}
): Idx {
	const { level, e, n } = key;
	const levels = level === 0 ? [0, 1] : [level + 1];
	for (let k = 0; k < extra; k++) levels.push(levels[levels.length - 1] + 1);
	const quarter = Math.floor(count / 4);
	const rows: PageRow[] = [];
	for (const g of levels) {
		const side = PAGE_SIDE * 2 ** g;
		const span = (LEAF * 2 ** level) / side;
		for (let j = 0; j < span; j++) {
			for (let i = 0; i < span; i++) {
				const box = Float32Array.of(i * side, j * side, 0, (i + 1) * side, (j + 1) * side, 5);
				const quadrants: [number, number, number] = [quarter, 2 * quarter, 3 * quarter];
				const offset = rows.length * size;
				rows.push({ g, i, j, count, quadrants, box, offset, length: size });
			}
		}
	}
	const below = (depth: number, column: number, row: number): UnitKey => {
		const side = LEAF * 2 ** (level - depth);
		return { level: level - depth, e: e + column * side, n: n + row * side };
	};
	const descendants: Idx['descendants'] = [];
	for (const depth of [2, 3]) {
		if (level < depth) continue;
		for (let row = 0; row < 2 ** depth; row++) {
			for (let column = 0; column < 2 ** depth; column++) {
				descendants.push({ depth, column, row, idx: hash(below(depth, column, row)) });
			}
		}
	}
	return {
		level,
		e,
		n,
		pack: hash(key),
		packSize: rows.length * size,
		col: null,
		rows,
		children: (level > 0 ? children : []).map((quadrant) => ({
			quadrant,
			idx: hash(below(1, quadrant & 1, quadrant >> 1))
		})),
		descendants
	};
}
