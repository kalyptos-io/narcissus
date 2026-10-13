// the page quadtree of an open world, grown as .idx files arrive

import { unitPath } from '../../format/idx.ts';
import { LEAF, PAGE_SIDE } from '../../format/spec.ts';
import type { Idx, PageRow, UnitKey, World } from '../../format/types.ts';

export interface UnitNode extends UnitKey {
	idx: Idx;
	/** world.json-relative path of its .idx */
	path: string;
	parent: UnitNode | null;
	pages: PageNode[];
}

export interface PageNode {
	/** unique for the life of the tree, never reused after a prune */
	id: number;
	unit: UnitNode;
	row: PageRow;
	g: number;
	/** extent box in world ENU metres: min e, n, h then max e, n, h */
	box: Float64Array;
	/** the page at g + 1 over it; null for a root's coarsest pages */
	parent: PageNode | null;
	/**
	 * by quadrant a + 2b: the page at g - 1, null where none exists, undefined while the unit
	 * holding it is known but its .idx not added; all null at g = 0
	 */
	children: (PageNode | null | undefined)[];
}

/** an .idx the tree knows of and lacks */
export interface Wanted extends UnitKey {
	path: string;
	/** pages over it, the nearest level up; the planner ranks the fetch by them */
	over: PageNode[];
}

const slot = (g: number, i: number, j: number) => (g * 256 + i) * 256 + j;

export class Tree {
	readonly world: World;
	/** the coarsest pages of every root */
	readonly roots: PageNode[] = [];
	readonly pages = new Map<number, PageNode>();
	readonly units = new Map<string, UnitNode>();
	#rootKeys: Set<string>;
	/** the highest root level, the top of every ancestor chain */
	#top: number;
	#next = 0;
	#grids = new Map<UnitNode, Map<number, PageNode>>();
	/** by unit key, with the level of the unit that named it */
	#wanted = new Map<string, { wanted: Wanted; from: number }>();
	/** by unit key, added units below it; absent for none */
	#below = new Map<string, number>();

	constructor(world: World) {
		this.world = world;
		this.#rootKeys = new Set(world.roots.map(unitKey));
		this.#top = Math.max(...world.roots.map((root) => root.level));
	}

	/** links a fetched .idx under its parent unit (a root has none); returns its node */
	add(idx: Idx, path: string): UnitNode {
		const key = unitKey(idx);
		const known = this.units.get(key);
		if (known) return known;
		const unit: UnitNode = {
			level: idx.level,
			e: idx.e,
			n: idx.n,
			idx,
			path,
			parent: null,
			pages: []
		};
		const grid = new Map<number, PageNode>();
		for (const row of idx.rows) {
			const b = row.box;
			const page: PageNode = {
				id: this.#next++,
				unit,
				row,
				g: row.g,
				box: Float64Array.of(idx.e + b[0], idx.n + b[1], b[2], idx.e + b[3], idx.n + b[4], b[5]),
				parent: null,
				children: [null, null, null, null]
			};
			this.pages.set(page.id, page);
			unit.pages.push(page);
			grid.set(slot(row.g, row.i, row.j), page);
		}
		this.units.set(key, unit);
		this.#grids.set(unit, grid);
		this.#wanted.delete(key);
		for (let level = idx.level + 1; level <= this.#top; level++) {
			const up = unitKey(ancestor(idx, level));
			this.#below.set(up, (this.#below.get(up) ?? 0) + 1);
		}

		// inside the unit
		const levels = new Set(idx.rows.map((row) => row.g));
		const top = Math.max(...levels);
		const lowest = idx.level === 0 ? 0 : idx.level + 1;
		const listed = new Set(idx.children.map((child) => child.quadrant));
		for (const page of unit.pages) {
			const { g, i, j } = page.row;
			if (levels.has(g + 1)) page.parent = grid.get(slot(g + 1, i >> 1, j >> 1)) ?? null;
			for (let q = 0; q < 4; q++) {
				const col = 2 * i + (q & 1);
				const row = 2 * j + (q >> 1);
				if (levels.has(g - 1)) {
					page.children[q] = grid.get(slot(g - 1, col, row)) ?? null;
				} else if (g === lowest && g > 0) {
					page.children[q] = listed.has((col >> 3) + 2 * (row >> 3)) ? undefined : null;
				}
			}
		}

		// across units, both ways
		if (this.#rootKeys.has(key)) {
			for (const page of unit.pages) if (page.g === top) this.roots.push(page);
		} else {
			const parent = this.units.get(unitKey(ancestor(idx, idx.level + 1)));
			if (parent) this.#link(parent, unit);
		}
		const named = this.#named(unit);
		for (const { key: child } of named) {
			const node = child.level === idx.level - 1 ? this.units.get(unitKey(child)) : undefined;
			if (node) this.#link(unit, node);
		}

		for (const { key: below, hash } of named) {
			const k = unitKey(below);
			if (this.units.has(k)) continue;
			const entry = this.#wanted.get(k);
			// the nearest namer's pages rank the fetch
			if (entry && entry.from <= unit.level) continue;
			const over = this.#over(unit, below);
			const wanted = { ...below, path: unitPath(below, hash, 'idx'), over };
			this.#wanted.set(k, { wanted, from: unit.level });
		}
		return unit;
	}

	/** .idx files named by added units (children and descendants) and not yet added */
	wanted(): Wanted[] {
		return Array.from(this.#wanted.values(), (entry) => entry.wanted);
	}

	/** the lowest extent minimum h of the finest page over (e, n), or undefined outside the world */
	ground(e: number, n: number): number | undefined {
		for (const root of this.roots) {
			let [x, y, side] = square(root);
			if (e < x || e >= x + side || n < y || n >= y + side) continue;
			let page = root;
			for (;;) {
				const a = e >= x + side / 2 ? 1 : 0;
				const b = n >= y + side / 2 ? 1 : 0;
				const child = page.children[a + 2 * b];
				if (!child) return page.box[2];
				page = child;
				[x, y, side] = square(page);
			}
		}
		return undefined;
	}

	/**
	 * removes every non-root unit with no page in keep and no added unit below it, deepest first;
	 * returns the ids of the pages it removed
	 */
	prune(keep: ReadonlySet<number>): number[] {
		const removed: number[] = [];
		const units = [...this.units.values()].sort((a, b) => a.level - b.level);
		for (const unit of units) {
			const key = unitKey(unit);
			if (this.#rootKeys.has(key) || this.#below.has(key)) continue;
			if (unit.pages.some((page) => keep.has(page.id))) continue;
			for (const page of unit.pages) {
				this.pages.delete(page.id);
				removed.push(page.id);
			}
			const parent = unit.parent;
			if (parent) {
				const half = LEAF * 2 ** unit.level;
				const qa = (unit.e - parent.e) / half;
				const qb = (unit.n - parent.n) / half;
				const open = parent.idx.children.some((child) => child.quadrant === qa + 2 * qb);
				for (const page of this.#over(parent, unit)) page.children.fill(open ? undefined : null);
			}
			this.units.delete(key);
			this.#grids.delete(unit);
			for (let level = unit.level + 1; level <= this.#top; level++) {
				const up = unitKey(ancestor(unit, level));
				const count = this.#below.get(up)! - 1;
				if (count) this.#below.set(up, count);
				else this.#below.delete(up);
			}
			for (const { key: below } of this.#named(unit)) this.#want(below);
			this.#want(unit);
		}
		return removed;
	}

	/** wants key again through the nearest added unit that names it, if any */
	#want(key: UnitKey): void {
		const k = unitKey(key);
		this.#wanted.delete(k);
		for (let level = key.level + 1; level <= key.level + 3; level++) {
			const namer = this.units.get(unitKey(ancestor(key, level)));
			if (!namer) continue;
			const named = this.#named(namer).find((entry) => unitKey(entry.key) === k);
			if (!named) continue;
			const wanted = {
				level: key.level,
				e: key.e,
				n: key.n,
				path: unitPath(named.key, named.hash, 'idx'),
				over: this.#over(namer, key)
			};
			this.#wanted.set(k, { wanted, from: namer.level });
			return;
		}
	}

	/** child is a quadrant of parent, one level down */
	#link(parent: UnitNode, child: UnitNode): void {
		child.parent = parent;
		const g = child.level + 1;
		const half = LEAF * 2 ** child.level;
		const qa = (child.e - parent.e) / half;
		const qb = (child.n - parent.n) / half;
		const over = this.#grids.get(parent)!;
		// the child's missing pages leave empty quadrants
		for (const page of this.#over(parent, child)) page.children.fill(null);
		for (const page of child.pages) {
			if (page.g !== g) continue;
			const col = 8 * qa + page.row.i;
			const row = 8 * qb + page.row.j;
			const up = over.get(slot(g + 1, col >> 1, row >> 1)) ?? null;
			page.parent = up;
			if (up) up.children[(col & 1) + 2 * (row & 1)] = page;
		}
	}

	/** the units an idx names: its children, then its descendants two and three levels down */
	#named(unit: UnitNode): { key: UnitKey; hash: string }[] {
		const { level, e, n, idx } = unit;
		const half = LEAF * 2 ** (level - 1);
		const named = idx.children.map(({ quadrant, idx: hash }) => ({
			key: { level: level - 1, e: e + (quadrant & 1) * half, n: n + (quadrant >> 1) * half },
			hash
		}));
		for (const { depth, column, row, idx: hash } of idx.descendants) {
			const side = LEAF * 2 ** (level - depth);
			named.push({ key: { level: level - depth, e: e + column * side, n: n + row * side }, hash });
		}
		return named;
	}

	/** the pages of ancestor unit a over the square of key, at a's lowest level */
	#over(a: UnitNode, key: UnitKey): PageNode[] {
		const grid = this.#grids.get(a)!;
		const g = a.level + 1;
		const side = PAGE_SIDE * 2 ** g;
		const i0 = (key.e - a.e) / side;
		const j0 = (key.n - a.n) / side;
		const span = (LEAF * 2 ** key.level) / side;
		const over: PageNode[] = [];
		for (let j = j0; j < j0 + span; j++)
			for (let i = i0; i < i0 + span; i++) {
				const page = grid.get(slot(g, i, j));
				if (page) over.push(page);
			}
		return over;
	}
}

export function unitKey(key: UnitKey): string {
	return `${key.level}/${key.e}/${key.n}`;
}

/** the unit at level holding key's square */
function ancestor(key: UnitKey, level: number): UnitKey {
	const side = LEAF * 2 ** level;
	return { level, e: Math.floor(key.e / side) * side, n: Math.floor(key.n / side) * side };
}

/** south-west corner and side of a page's square, world metres */
function square(page: PageNode): [number, number, number] {
	const side = PAGE_SIDE * 2 ** page.g;
	return [page.unit.e + page.row.i * side, page.unit.n + page.row.j * side, side];
}
