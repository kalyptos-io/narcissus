// the unit tree of an open world, grown as .idx files arrive

import {
	namedUnits,
	quadrantOf,
	unitKey,
	unitPath,
	LEAF,
	PAGE_SIDE,
	type Idx,
	type PageRow,
	type UnitKey,
	type World
} from '../../format/index.ts';

export interface UnitNode extends UnitKey {
	idx: Idx;
	/** world.json-relative path of its .idx */
	path: string;
	parent: UnitNode | null;
	/** by quadrant a + 2b: null where its .idx names none, undefined while named and not added */
	children: (UnitNode | null | undefined)[];
	/** by row, as links name them */
	pages: PageNode[];
}

export interface PageNode {
	/** unique for the life of the tree, never reused after a prune */
	id: number;
	unit: UnitNode;
	row: PageRow;
	/** extent box in world ENU metres: min e, n, h then max e, n, h */
	box: Float64Array;
}

/** an .idx the tree knows of and lacks */
export interface Wanted extends UnitKey {
	path: string;
}

/** hears of every unit the tree adds and prunes */
export interface TreeListener {
	added(unit: UnitNode, root: boolean): void;
	pruned(units: UnitNode[]): void;
}

export class Tree {
	/** the units with no parent */
	readonly roots: UnitNode[] = [];
	readonly pages = new Map<number, PageNode>();
	readonly units = new Map<string, UnitNode>();
	#rootKeys: Set<string>;
	/** the highest root level, the top of every ancestor chain */
	#top: number;
	#next = 0;
	/** by unit key, with the level of the unit that named it */
	#wanted = new Map<string, { wanted: Wanted; from: number }>();
	/** by unit key, added units below it; absent for none */
	#below = new Map<string, number>();
	#listener: TreeListener | undefined;

	constructor(world: World, listener?: TreeListener) {
		this.#rootKeys = new Set(world.roots.map(unitKey));
		this.#top = Math.max(...world.roots.map((root) => root.level));
		this.#listener = listener;
	}

	/** links a fetched .idx to its parent and children units; returns its node */
	add(idx: Idx, path: string): UnitNode {
		const key = unitKey(idx);
		const known = this.units.get(key);
		if (known) return known;
		const named = new Set(idx.children.map((child) => child.quadrant));
		const unit: UnitNode = {
			level: idx.level,
			e: idx.e,
			n: idx.n,
			idx,
			path,
			parent: null,
			children: [0, 1, 2, 3].map((q) => (named.has(q) ? undefined : null)),
			pages: []
		};
		for (const row of idx.rows) {
			const b = row.box;
			const page: PageNode = {
				id: this.#next++,
				unit,
				row,
				box: Float64Array.of(idx.e + b[0], idx.n + b[1], b[2], idx.e + b[3], idx.n + b[4], b[5])
			};
			this.pages.set(page.id, page);
			unit.pages.push(page);
		}
		this.units.set(key, unit);
		this.#wanted.delete(key);
		for (let level = idx.level + 1; level <= this.#top; level++) {
			const up = unitKey(ancestor(idx, level));
			this.#below.set(up, (this.#below.get(up) ?? 0) + 1);
		}

		const root = this.#rootKeys.has(key);
		if (root) this.roots.push(unit);
		else {
			const parent = this.units.get(unitKey(ancestor(idx, idx.level + 1)));
			if (parent) link(parent, unit);
		}
		const names = namedUnits(idx);
		for (const { key: child } of names.slice(0, idx.children.length)) {
			const node = this.units.get(unitKey(child));
			if (node) link(unit, node);
		}

		for (const { key: below, hash } of names) {
			const k = unitKey(below);
			if (this.units.has(k)) continue;
			const entry = this.#wanted.get(k);
			// the nearest namer's word stands
			if (entry && entry.from <= unit.level) continue;
			const wanted = { ...below, path: unitPath(below, hash, 'idx') };
			this.#wanted.set(k, { wanted, from: unit.level });
		}
		this.#listener?.added(unit, root);
		return unit;
	}

	/** .idx files named by added units (children and descendants) and not yet added */
	wanted(): Wanted[] {
		return Array.from(this.#wanted.values(), (entry) => entry.wanted);
	}

	/** the lowest extent minimum h of the finest added page over (e, n), or undefined outside the world */
	ground(e: number, n: number): number | undefined {
		for (const root of this.roots) {
			if (!holds(root, e, n)) continue;
			let unit = root;
			for (;;) {
				const half = (LEAF * 2 ** unit.level) / 2;
				const q = (e >= unit.e + half ? 1 : 0) + 2 * (n >= unit.n + half ? 1 : 0);
				const child = unit.children[q];
				if (!child) break;
				unit = child;
			}
			for (let at: UnitNode | null = unit; at; at = at.parent) {
				let finest: PageNode | null = null;
				for (const page of at.pages) {
					if (finest && page.row.g >= finest.row.g) continue;
					const [x, y, side] = square(page);
					if (e >= x && e < x + side && n >= y && n < y + side) finest = page;
				}
				if (finest) return finest.box[2];
			}
			return undefined;
		}
		return undefined;
	}

	/** adds every unit over (e, n) that the tree knows of and lacks, each .idx read by fetch */
	async load(e: number, n: number, fetch: (path: string) => Promise<Idx>): Promise<void> {
		for (;;) {
			const over = this.wanted().filter((key) => holds(key, e, n));
			if (over.length === 0) return;
			const fetched = await Promise.all(over.map((key) => fetch(key.path)));
			fetched.forEach((idx, k) => this.add(idx, over[k].path));
		}
	}

	/** removes every non-root unit with no page in keep and no added unit below it, deepest first */
	prune(keep: ReadonlySet<number>): UnitNode[] {
		const removed: UnitNode[] = [];
		const units = [...this.units.values()].sort((a, b) => a.level - b.level);
		for (const unit of units) {
			const key = unitKey(unit);
			if (this.#rootKeys.has(key) || this.#below.has(key)) continue;
			if (unit.pages.some((page) => keep.has(page.id))) continue;
			for (const page of unit.pages) this.pages.delete(page.id);
			removed.push(unit);
			const parent = unit.parent;
			if (parent) parent.children[quadrantOf(parent, unit)] = undefined;
			this.units.delete(key);
			for (let level = unit.level + 1; level <= this.#top; level++) {
				const up = unitKey(ancestor(unit, level));
				const count = this.#below.get(up)! - 1;
				if (count) this.#below.set(up, count);
				else this.#below.delete(up);
			}
			for (const { key: below } of namedUnits(unit.idx)) this.#want(below);
			this.#want(unit);
		}
		if (removed.length) this.#listener?.pruned(removed);
		return removed;
	}

	/** wants key again through the nearest added unit that names it, if any */
	#want(key: UnitKey): void {
		const k = unitKey(key);
		this.#wanted.delete(k);
		for (let level = key.level + 1; level <= key.level + 3; level++) {
			const namer = this.units.get(unitKey(ancestor(key, level)));
			if (!namer) continue;
			const named = namedUnits(namer.idx).find((entry) => unitKey(entry.key) === k);
			if (!named) continue;
			const wanted = {
				level: key.level,
				e: key.e,
				n: key.n,
				path: unitPath(key, named.hash, 'idx')
			};
			this.#wanted.set(k, { wanted, from: namer.level });
			return;
		}
	}
}

/** child is a quadrant of parent, one level down */
function link(parent: UnitNode, child: UnitNode): void {
	child.parent = parent;
	parent.children[quadrantOf(parent, child)] = child;
}

/** the unit at level holding key's square */
function ancestor(key: UnitKey, level: number): UnitKey {
	const side = LEAF * 2 ** level;
	return { level, e: Math.floor(key.e / side) * side, n: Math.floor(key.n / side) * side };
}

/** whether key's square holds (e, n) */
function holds(key: UnitKey, e: number, n: number): boolean {
	const side = LEAF * 2 ** key.level;
	return e >= key.e && e < key.e + side && n >= key.n && n < key.n + side;
}

/** south-west corner and side of a page's square, world metres */
export function square(page: PageNode): [number, number, number] {
	const side = PAGE_SIDE * 2 ** page.row.g;
	return [page.unit.e + page.row.i * side, page.unit.n + page.row.j * side, side];
}
