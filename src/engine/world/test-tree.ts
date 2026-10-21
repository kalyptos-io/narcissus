// .idx fixtures for the tests that grow a tree

import {
	evenBits,
	LEAF,
	PAGE_SIDE,
	TOP_PAGE,
	type Idx,
	type PageRow,
	type UnitKey,
	type World
} from '../../format/index.ts';

export function hash({ level, e, n }: UnitKey): string {
	return ((level * 4096 + e / LEAF) * 65536 + n / LEAF).toString(16).padStart(16, '0');
}

/** a world of roots; a tree reads nothing else of it */
export function world(...roots: UnitKey[]): World {
	return {
		version: 2,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: LEAF,
		roots: roots.map((key) => ({ ...key, idx: `u/${key.level}/${key.e}/${key.n}.idx` })),
		extent: { e: [0, 0], n: [0, 0], h: [0, 0] },
		extra: {}
	};
}

export interface UnitOptions {
	/** nodes a page */
	count?: number;
	/** a root's top page after its own bands */
	top?: boolean;
	/** quadrants whose child unit is named */
	children?: number[];
	/** bytes a page, back to back in the pack */
	size?: number;
}

/** a full unit of flat ground: every page of its own bands present, every descendant named */
export function unit(
	key: UnitKey,
	{ count = 1000, top = false, children = [0, 1, 2, 3], size = 0 }: UnitOptions = {}
): Idx {
	const { level, e, n } = key;
	const side = LEAF * 2 ** level;
	const rows: PageRow[] = [];
	const add = (g: number, i: number, j: number, flags: number, box: Float32Array) => {
		const offset = rows.length * size;
		rows.push({ g, i, j, flags, count, box, offset, length: size });
	};
	for (const g of level === 0 ? [0, 1] : [level + 1]) {
		const page = PAGE_SIDE * 2 ** g;
		const span = side / page;
		for (let m = 0; m < span * span; m++) {
			const [i, j] = [evenBits(m), evenBits(m >> 1)];
			add(g, i, j, 0, Float32Array.of(i * page, j * page, 0, (i + 1) * page, (j + 1) * page, 5));
		}
	}
	if (top) add(level + 2, 0, 0, TOP_PAGE, Float32Array.of(0, 0, 0, side, side, 5));
	const below = (depth: number, column: number, row: number): UnitKey => {
		const at = LEAF * 2 ** (level - depth);
		return { level: level - depth, e: e + column * at, n: n + row * at };
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
