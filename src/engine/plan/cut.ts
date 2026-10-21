// the cut: which nodes the views draw within the budget, and which pages and .idx files to load;
// pure, so it runs in the plan worker and in node

import {
	childKey,
	linkRow,
	linkStart,
	linkUnit,
	namedUnits,
	quadrantOf,
	unitKey,
	unitPath,
	TOP_PAGE,
	type PageNodes
} from '../../format/index.ts';
import { slots } from '../gpu/layout.ts';
import { view as viewMatrix } from '../math/mat4.ts';
import type { Camera, Drawn } from '../types.ts';
import type { UnitNode } from '../world/tree.ts';

/** px: a node this size or smaller is never refined */
export const T_MIN = 1;
/** nodes a cut may draw per node of budget */
export const CAP = 1.1;
/** the first round's threshold, in T_MIN */
const START = 1000;
/** weight of a node behind the camera; one off screen tapers to it */
const FLOOR = 0.05;
/** a link into an unknown child this many thresholds large also wants the .idx files under it */
const DEEP = 4;
/** a parent this share of the threshold or larger has the page it refines into fetched ahead of need */
const AHEAD = 0.5;

/** a unit as the cut knows it */
export interface UnitInfo {
	level: number;
	e: number;
	n: number;
	/** a unit with no parent; its top page starts the cut */
	root: boolean;
	/** by row, as links name them */
	rows: { id: number; count: number; top: boolean }[];
	/** by quadrant: the child's .idx path, null where none is named */
	children: (string | null)[];
	/** by quadrant: the .idx paths of the units two and three levels down inside it */
	descendants: string[][];
}

export interface CutView {
	/** world metres */
	eye: readonly [number, number, number];
	/** the world-to-view rotation, row-major: view x right, y up, z back */
	rotation: ArrayLike<number>;
	/** the projection's x and y scales, proj[0] and proj[5] */
	p00: number;
	p11: number;
	/** pixels */
	width: number;
	height: number;
}

const DEG = Math.PI / 180;

/** camera's view of a width x height target at its full-scale size, so a lower render scale costs sharpness, not detail */
export function cutView(camera: Camera, width: number, height: number, scale: number): CutView {
	const m = viewMatrix(new Float64Array(16), [0, 0, 0], camera.yaw * DEG, camera.pitch * DEG);
	const p11 = 1 / Math.tan((camera.fov * DEG) / 2);
	return {
		eye: [camera.e, camera.n, camera.h],
		rotation: [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]],
		p00: (p11 * height) / width,
		p11,
		width: width / scale,
		height: height / scale
	};
}

export interface CutRequest {
	/** the camera, and the camera a moment ahead while it moves */
	views: CutView[];
	/** nodes drawn */
	budget: number;
	/** pool slots the touched and wanted pages may take, as slots() counts them */
	capacity: number;
}

export interface CutResult {
	/** the pages whose draw mask changed since the last applied plan */
	masks: Drawn[];
	/** ids of the pages the cut reads, which the pool must keep */
	touched: number[];
	/** ids of the pages to load, most wanted first */
	load: number[];
	/** .idx paths to fetch, most wanted first */
	idx: string[];
	/** nodes drawn */
	planned: number;
	/** of planned, the nodes whose family waits for its page or .idx */
	missing: number;
	/** px, the last round's threshold */
	detail: number;
	/** nodes of the pages drawn, which the gpu projects and masks */
	projected: number;
	/** ms the plan took */
	ms: number;
}

type Row = UnitInfo['rows'][number];

interface Unit extends UnitInfo {
	/** by quadrant, the child's key */
	keys: string[];
}

interface Page {
	id: number;
	unit: Unit;
	nodes: PageNodes;
	/** parents before each 32-node word */
	ranks: Uint32Array;
	seen: Uint32Array;
	refined: Uint32Array;
	/** the plan that last touched it, and its index in that plan's touched pages */
	stamp: number;
	index: number;
	/** its unit's corner less each view's eye, 3 a view */
	offset: Float64Array;
}

/** buckets of the queue, a doubling of size each from 1 px up to 2^30 */
const BUCKETS = 32;

const bucket = (size: number) => 31 - Math.clz32(Math.min(size, 2 ** 30));

/** parents waiting to refine, in buckets of size; a bucket gives its newest first */
class Queue {
	size = 0;
	/** the highest bucket that may hold any */
	top = -1;
	heads = new Int32Array(BUCKETS).fill(-1);
	/** per entry: its page's index in the plan's touched pages, its node and rank, its size, the next in its bucket */
	pages = new Int32Array(1024);
	nodes = new Int32Array(1024);
	ranks = new Int32Array(1024);
	sizes = new Float64Array(1024);
	next = new Int32Array(1024);
	#used = 0;

	reset(): void {
		this.heads.fill(-1);
		this.top = -1;
		this.size = 0;
		this.#used = 0;
	}

	/** returns its bucket */
	push(page: number, node: number, rank: number, size: number): number {
		const k = this.#used++;
		if (k === this.next.length) this.#grow();
		const b = bucket(size);
		this.pages[k] = page;
		this.nodes[k] = node;
		this.ranks[k] = rank;
		this.sizes[k] = size;
		this.next[k] = this.heads[b];
		this.heads[b] = k;
		this.top = Math.max(this.top, b);
		this.size++;
		return b;
	}

	/** the newest entry of bucket b, or -1 */
	pop(b: number): number {
		const k = this.heads[b];
		if (k >= 0) {
			this.heads[b] = this.next[k];
			this.size--;
		}
		return k;
	}

	#grow(): void {
		const grow = <T extends Int32Array | Float64Array>(a: T): T => {
			const bigger = new (a.constructor as new (n: number) => T)(2 * a.length);
			bigger.set(a);
			return bigger;
		};
		this.pages = grow(this.pages);
		this.nodes = grow(this.nodes);
		this.ranks = grow(this.ranks);
		this.sizes = grow(this.sizes);
		this.next = grow(this.next);
	}
}

/** the UnitInfo of a unit of the tree */
export function unitInfo(unit: UnitNode, root: boolean): UnitInfo {
	const { idx } = unit;
	const children: (string | null)[] = [null, null, null, null];
	const descendants: string[][] = [[], [], [], []];
	const names = namedUnits(idx);
	names.forEach(({ key, hash }, k) => {
		const path = unitPath(key, hash, 'idx');
		const quadrant = quadrantOf(idx, key);
		if (k < idx.children.length) children[quadrant] = path;
		else descendants[quadrant].push(path);
	});
	return {
		level: unit.level,
		e: unit.e,
		n: unit.n,
		root,
		rows: unit.pages.map(({ id, row }) => ({
			id,
			count: row.count,
			top: (row.flags & TOP_PAGE) !== 0
		})),
		children,
		descendants
	};
}

export class Cut {
	#units = new Map<string, Unit>();
	#pages = new Map<number, Page>();
	/** page id to its unit */
	#rows = new Map<number, Unit>();
	/** the masks of the last applied plan, and of the last computed one, drawn pages alone */
	#applied = new Map<number, Uint32Array>();
	#pending: Map<number, Uint32Array> | null = null;
	#stamp = 0;
	#queue = new Queue();

	unit(info: UnitInfo): void {
		const keys = [0, 1, 2, 3].map((q) => unitKey(childKey(info, q)));
		const unit = { ...info, keys };
		this.#units.set(unitKey(info), unit);
		for (const row of info.rows) this.#rows.set(row.id, unit);
	}

	drop(key: string): void {
		const unit = this.#units.get(key);
		if (!unit) return;
		this.#units.delete(key);
		for (const row of unit.rows) {
			this.#rows.delete(row.id);
			this.evict(row.id);
		}
	}

	/** a page the pool holds; ignored while its unit is unknown */
	page(id: number, nodes: PageNodes): void {
		const unit = this.#rows.get(id);
		if (!unit) return;
		const { counts } = nodes;
		const words = Math.ceil(counts.length / 32);
		const ranks = new Uint32Array(words);
		for (let w = 0, r = 0; w < words; w++) {
			ranks[w] = r;
			for (let t = 32 * w; t < Math.min(32 * w + 32, counts.length); t++) if (counts[t]) r++;
		}
		this.#pages.set(id, {
			id,
			unit,
			nodes,
			ranks,
			seen: new Uint32Array(words),
			refined: new Uint32Array(words),
			stamp: 0,
			index: 0,
			offset: new Float64Array(6)
		});
	}

	/** a page the pool let go of */
	evict(id: number): void {
		this.#pages.delete(id);
		this.#applied.delete(id);
		this.#pending?.delete(id);
	}

	/** whether the pool took the last plan's masks; the next plan's changes are against what it holds */
	verdict(applied: boolean): void {
		if (applied && this.#pending) this.#applied = this.#pending;
		this.#pending = null;
	}

	plan({ views, budget, capacity }: CutRequest): CutResult {
		const started = performance.now();
		const stamp = ++this.#stamp;
		const cap = Math.floor(CAP * budget);
		// per view: the rotation's rows, the projection's scales and the focal length in pixels
		const at = new Float64Array(12 * views.length);
		views.forEach((v, k) => {
			for (let c = 0; c < 9; c++) at[12 * k + c] = v.rotation[c];
			at.set([v.p00, v.p11, Math.max(v.p00 * v.width, v.p11 * v.height) / 2], 12 * k + 9);
		});
		const touched: Page[] = [];
		const pages = new Map<number, number>();
		const files = new Map<string, number>();
		const queue = this.#queue;
		queue.reset();
		let taken = 0;
		let used = 0;
		let missing = 0;

		const touch = (page: Page) => {
			page.stamp = stamp;
			page.seen.fill(0);
			page.refined.fill(0);
			for (let k = 0; k < views.length; k++) {
				page.offset[3 * k] = page.unit.e - views[k].eye[0];
				page.offset[3 * k + 1] = page.unit.n - views[k].eye[1];
				page.offset[3 * k + 2] = -views[k].eye[2];
			}
			page.index = touched.length;
			touched.push(page);
			taken += slots(page.nodes.counts.length);
			return page.index;
		};
		const room = (count: number) => taken + slots(count) <= capacity;
		const want = (id: number, count: number, priority: number) => {
			const known = pages.get(id);
			if (known !== undefined) {
				if (priority > known) pages.set(id, priority);
				return true;
			}
			if (!room(count)) return false;
			pages.set(id, priority);
			taken += slots(count);
			return true;
		};
		const fetch = (path: string, priority: number) => {
			if (priority > (files.get(path) ?? -1)) files.set(path, priority);
		};
		// the row a parent's link names; into a child unit not yet known, its .idx (and with deep those under it) is fetched when there is room
		const follow = (
			page: Page,
			link: number,
			s: number,
			deep: boolean
		): Row | 'fetched' | undefined => {
			const quadrant = linkUnit(link) - 1;
			const unit = quadrant < 0 ? page.unit : this.#units.get(page.unit.keys[quadrant]);
			if (unit) return unit.rows[linkRow(link)];
			const path = page.unit.children[quadrant];
			// a family's page holds about as many nodes as its parent's, so one the pool has no room for is not fetched
			if (!path || !room(page.nodes.counts.length)) return undefined;
			fetch(path, s);
			// below the child, which the cut needs first
			if (deep) for (const below of page.unit.descendants[quadrant]) fetch(below, s / 2);
			return 'fetched';
		};
		const size = (page: Page, rank: number) => {
			const { centres, radii } = page.nodes;
			const { offset } = page;
			let most = 0;
			for (let k = 0, v = 0; v < views.length; k += 12, v++) {
				const dx = centres[3 * rank] + offset[3 * v];
				const dy = centres[3 * rank + 1] + offset[3 * v + 1];
				const dz = centres[3 * rank + 2] + offset[3 * v + 2];
				const depth = -(at[k + 6] * dx + at[k + 7] * dy + at[k + 8] * dz);
				let weight = FLOOR;
				if (depth > 0) {
					const x = Math.abs(at[k + 9] * (at[k] * dx + at[k + 1] * dy + at[k + 2] * dz));
					const y = Math.abs(at[k + 10] * (at[k + 3] * dx + at[k + 4] * dy + at[k + 5] * dz));
					const c = depth / Math.max(depth, x, y);
					weight += (1 - FLOOR) * c * c;
				}
				const distance = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-6);
				most = Math.max(most, (2 * radii[rank] * at[k + 11] * weight) / distance);
			}
			return most;
		};
		// a family enters the cut; its parents large enough and small enough to fit wait to refine; returns the highest bucket it filled
		const enter = (index: number, start: number, count: number) => {
			const page = touched[index];
			const { counts } = page.nodes;
			let rank = page.ranks[start >> 5];
			for (let t = start & ~31; t < start; t++) if (counts[t]) rank++;
			let high = -1;
			for (let t = start; t < start + count; t++) {
				page.seen[t >> 5] |= 1 << (t & 31);
				const children = counts[t];
				if (!children) continue;
				const r = rank++;
				if (children - 1 > cap - used) continue;
				const s = size(page, r);
				if (s > T_MIN) high = Math.max(high, queue.push(index, t, r, s));
			}
			return high;
		};

		for (const unit of this.#units.values()) {
			if (!unit.root) continue;
			const top = unit.rows.find((row) => row.top);
			if (!top) continue;
			const page = this.#pages.get(top.id);
			if (!page) {
				want(top.id, top.count, Infinity);
				continue;
			}
			used += top.count;
			enter(touch(page), 0, top.count);
		}

		let threshold = START * T_MIN;
		for (;;) {
			// everything above the threshold refines, the largest buckets first; the rest of its bucket waits
			const low = bucket(threshold);
			let parked = -1;
			let waiting = 0;
			for (let b = queue.top; b >= low;) {
				const k = queue.pop(b);
				if (k < 0) {
					b--;
					continue;
				}
				const s = queue.sizes[k];
				if (s <= threshold) {
					queue.next[k] = parked;
					parked = k;
					waiting++;
					continue;
				}
				const page = touched[queue.pages[k]];
				const node = queue.nodes[k];
				const count = page.nodes.counts[node];
				if (count - 1 > cap - used) continue;
				const link = page.nodes.links[queue.ranks[k]];
				const row = follow(page, link, s, s > DEEP * threshold);
				if (row === 'fetched') {
					missing++;
					continue;
				}
				// a link past the listed rows, or past its page, is the writer's fault; the parent stays
				if (!row || linkStart(link) + count > row.count) continue;
				const target = this.#pages.get(row.id);
				if (!target) {
					if (want(row.id, row.count, s)) missing++;
					continue;
				}
				let index = target.index;
				if (target.stamp !== stamp) {
					if (!room(row.count)) continue;
					index = touch(target);
				}
				used += count - 1;
				page.refined[node >> 5] |= 1 << (node & 31);
				b = Math.max(b, enter(index, linkStart(link), count));
			}
			queue.heads[low] = parked;
			queue.size += waiting;
			queue.top = low;
			if (!queue.size || used >= budget) break;
			threshold = Math.max(T_MIN, threshold / 2, 0.99 * threshold * Math.sqrt(used / budget));
		}

		// a page arriving late is drawn at once, so the parents nearest the threshold want theirs now, below every refinement
		const near = threshold * AHEAD;
		for (let b = queue.top; b >= 0 && b >= bucket(near); b--) {
			for (let k = queue.pop(b); k >= 0; k = queue.pop(b)) {
				const s = queue.sizes[k];
				if (s <= near) continue;
				const page = touched[queue.pages[k]];
				const row = follow(page, page.nodes.links[queue.ranks[k]], s, false);
				if (!row || row === 'fetched') continue;
				const target = this.#pages.get(row.id);
				// one fetched ahead is read, so the pool keeps it until its parent refines
				if (!target) want(row.id, row.count, s);
				else if (target.stamp !== stamp && room(row.count)) touch(target);
			}
		}

		const masks: Drawn[] = [];
		const pending = new Map<number, Uint32Array>();
		let projected = 0;
		for (const page of touched) {
			const { seen, refined } = page;
			const mask = new Uint32Array(seen.length);
			let any = 0;
			for (let w = 0; w < seen.length; w++) any |= mask[w] = seen[w] & ~refined[w];
			const before = this.#applied.get(page.id);
			if (any) {
				pending.set(page.id, mask);
				projected += page.nodes.counts.length;
			}
			if (before ? !same(before, mask) : any)
				masks.push({ id: page.id, mask: any ? mask : new Uint32Array(0) });
		}
		for (const id of this.#applied.keys()) {
			if (this.#pages.get(id)?.stamp !== stamp) masks.push({ id, mask: new Uint32Array(0) });
		}
		this.#pending = pending;
		const ranked = <K>(wanted: Map<K, number>) =>
			[...wanted].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key]) => key);
		return {
			masks,
			touched: touched.map((page) => page.id),
			load: ranked(pages),
			idx: ranked(files),
			planned: used,
			missing,
			detail: threshold,
			projected,
			ms: performance.now() - started
		};
	}
}

function same(a: Uint32Array, b: Uint32Array): boolean {
	if (a.length !== b.length) return false;
	for (let w = 0; w < a.length; w++) if (a[w] !== b[w]) return false;
	return true;
}
