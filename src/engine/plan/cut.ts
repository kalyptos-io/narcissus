// which pages the view should draw and load, inside the draw budget and the pool

import { slots } from '../gpu/layout.ts';
import { quadrantSplats } from './draw.ts';
import { footprint, shownQuadrants, type Footprint } from './footprint.ts';
import { square, type PageNode, type Tree, type Wanted } from '../world/tree.ts';

/** a page refined in the last plan stays refined until its count reaches the target times this */
export const MARGIN = 1 / 0.8 ** 2;
/** ms a refinement seen on screen stays while off screen */
export const HOLD = 1500;
const FRINGE = 1.1;

export interface View {
	/** world position of the floating origin; boxes are moved into its frame */
	origin: readonly [number, number, number];
	/** column-major world-to-view in the floating-origin frame */
	view: Float64Array;
	width: number;
	height: number;
	/** tan(fov / 2), vertical */
	tan: number;
	near: number;
	far: number;
}

export interface PlanOptions {
	/** splats drawn inside the frustum */
	budget: number;
	/** pool slots the kept pages may take, as slots() counts them */
	capacity: number;
	/** ms, performance clock */
	now: number;
	/** the camera a moment ahead, refined like the current one */
	predicted?: View;
}

export interface Plan {
	/** the pages to draw; a refined page draws the quadrants it handed to no child */
	cut: PageNode[];
	/** pages to load, most wanted first, each one's parent resident; the fringe once the screen is whole and the camera rests */
	load: PageNode[];
	/** .idx files to fetch, most wanted first */
	idx: Wanted[];
	/** ids the pool must keep: the cut, its ancestors and held pages */
	keep: Set<number>;
	/** splats of the cut's quadrants inside the frustum */
	planned: number;
	/** of planned, the splats not resident yet */
	missing: number;
}

interface Measure {
	page: PageNode;
	/** on screen at margin 1 */
	shown: boolean;
	/** on screen now or ahead, at margin 1 */
	near: boolean;
	/** splats of its quadrants on screen */
	visible: number;
	pixels: number;
	weight: number;
}

interface Step {
	page: PageNode;
	shown: boolean;
	/** refined last plan and on screen within HOLD: the quadrants it handed down stay */
	held: number | null;
	visible: number;
	ratio: number;
}

/** keeps the hysteresis and the hold between plans */
export class Planner {
	/** by id, the quadrants each refined page handed to its children, a bit each */
	#refined = new Map<number, number>();
	/** when each refined page was last on screen */
	#seen = new Map<number, number>();
	#out: Footprint = { shown: false, pixels: 0, weight: 1 };

	plan(tree: Tree, view: View, resident: (id: number) => boolean, options: PlanOptions): Plan {
		const { budget, capacity, now, predicted } = options;
		const order: PageNode[] = [];
		const visible: number[] = [];
		const near: boolean[] = [];
		const refined = new Map<number, number>();
		const seen = new Map<number, number>();
		const wanted = tree.wanted();
		const priority = new Map<number, number>();
		const queue = new Queue();
		let planned = 0;
		let kept = 0;

		const enter = (m: Measure) => {
			const page = m.page;
			const count = page.row.count;
			order.push(page);
			visible.push(m.visible);
			near.push(m.near);
			kept += slots(count);
			planned += m.visible;
			const handed = this.#refined.get(page.id);
			const was = handed !== undefined;
			const target = m.pixels * m.weight;
			// rank by need alone: ranked up by the margin, it would meet the budget before what freed it
			const ratio = target / Math.max(1, count);
			if (wanted.length && m.pixels > 0) priority.set(page.id, ratio);
			const held =
				was && !m.shown && now - (this.#seen.get(page.id) ?? -Infinity) <= HOLD ? handed : null;
			if ((count < target * (was ? MARGIN : 1) || held !== null) && refinable(page, resident))
				queue.push({ page, shown: m.shown, held, visible: m.visible, ratio });
		};

		for (const root of tree.roots) enter(this.#measure(root, view, predicted));
		// once a refinement on screen misses the budget, only off-screen ones go on until one frees budget
		const blocked: Step[] = [];
		while (queue.size) {
			const step = queue.pop();
			const { page, shown, held } = step;
			// quadrants off even the fringe stay with the page, which draws them unseen, so off budget
			const parts: Measure[] = [];
			let quadrants = 0;
			for (let q = 0; q < page.children.length; q++) {
				const child = page.children[q];
				if (!child) continue;
				const m = this.#measure(child, view, predicted);
				if (m.pixels <= 0 && !((held ?? 0) & (1 << q))) continue;
				parts.push(m);
				quadrants |= 1 << q;
			}
			if (!parts.length) continue;
			let grow = 0;
			let delta = -step.visible;
			for (const m of parts) {
				grow += slots(m.page.row.count);
				delta += m.visible;
			}
			if (kept + grow > capacity) break;
			if (delta > 0 && (blocked.length || planned + delta > budget)) {
				blocked.push(step);
				continue;
			}
			// a page at the edge frees budget when its children show less of it
			if (delta < 0) for (const b of blocked.splice(0)) queue.push(b);
			refined.set(page.id, quadrants);
			const last = shown ? now : this.#seen.get(page.id);
			if (last !== undefined) seen.set(page.id, last);
			planned -= step.visible;
			for (const m of parts) enter(m);
		}
		this.#refined = refined;
		this.#seen = seen;

		const cut: PageNode[] = [];
		const pending: { page: PageNode; near: boolean }[] = [];
		const keep = new Set(refined.keys());
		let missing = 0;
		for (let i = 0; i < order.length; i++) {
			const page = order[i];
			if (refined.has(page.id)) continue;
			cut.push(page);
			keep.add(page.id);
			if (!resident(page.id)) {
				missing += visible[i];
				pending.push({ page, near: near[i] });
			}
		}
		const ranked: { wanted: Wanted; rank: number }[] = [];
		for (const item of wanted) {
			let rank = -1;
			for (const page of item.over) rank = Math.max(rank, priority.get(page.id) ?? -1);
			if (rank >= 0) ranked.push({ wanted: item, rank });
		}
		ranked.sort((a, b) => b.rank - a.rank);
		return {
			cut,
			// fringe last: it holds up the screen's pages in the workers, and its uploads cost moving frames
			load: pending
				.filter(({ near }) => near || (!predicted && missing === 0))
				.map(({ page }) => page),
			idx: ranked.map((entry) => entry.wanted),
			keep,
			planned,
			missing
		};
	}

	/** the fringe footprint, the larger of now and ahead */
	#measure(page: PageNode, view: View, predicted: View | undefined): Measure {
		const current = this.#project(page, view, FRINGE);
		const shown = current.shown;
		let { pixels, weight } = current;
		let near = shown;
		if (predicted) {
			const ahead = this.#project(page, predicted, FRINGE);
			if (ahead.pixels > pixels) ({ pixels, weight } = ahead);
			near ||= ahead.shown;
		}
		return { page, shown, near, visible: shown ? visibleSplats(page, view) : 0, pixels, weight };
	}

	#project(page: PageNode, view: View, margin: number): Footprint {
		const { width, height, tan, near, far } = view;
		return footprint(
			page.box,
			view.view,
			width,
			height,
			tan,
			near,
			far,
			margin,
			this.#out,
			view.origin
		);
	}
}

function visibleSplats(page: PageNode, view: View): number {
	const { width, height, tan, near, far, origin } = view;
	const mask = shownQuadrants(
		page.box,
		square(page),
		view.view,
		width,
		height,
		tan,
		near,
		far,
		origin
	);
	let splats = 0;
	for (let q = 0; q < 4; q++) if (mask & (1 << q)) splats += quadrantSplats(page.row, q);
	return splats;
}

/** resident, with every child known and at least one there */
function refinable(page: PageNode, resident: (id: number) => boolean): boolean {
	const { children } = page;
	return (
		page.g > 0 &&
		resident(page.id) &&
		!children.includes(undefined) &&
		children.some((c) => c !== null)
	);
}

/** max-heap of steps: on screen first, then by ratio */
class Queue {
	#items: Step[] = [];

	get size(): number {
		return this.#items.length;
	}

	push(step: Step): void {
		const items = this.#items;
		items.push(step);
		let i = items.length - 1;
		while (i > 0) {
			const up = (i - 1) >> 1;
			if (!before(step, items[up])) break;
			items[i] = items[up];
			i = up;
		}
		items[i] = step;
	}

	pop(): Step {
		const items = this.#items;
		const top = items[0];
		const last = items.pop()!;
		if (items.length) {
			let i = 0;
			while (2 * i + 1 < items.length) {
				let child = 2 * i + 1;
				if (child + 1 < items.length && before(items[child + 1], items[child])) child++;
				if (!before(items[child], last)) break;
				items[i] = items[child];
				i = child;
			}
			items[i] = last;
		}
		return top;
	}
}

function before(a: Step, b: Step): boolean {
	return a.shown !== b.shown ? a.shown : a.ratio > b.ratio;
}
