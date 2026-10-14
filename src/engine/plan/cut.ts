// which pages the view should draw and load, inside the draw budget and the pool

import { slots } from '../gpu/layout.ts';
import { footprint, type Footprint } from './footprint.ts';
import type { PageNode, Tree, Wanted } from '../world/tree.ts';

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
	/** splats of the cut inside the frustum */
	planned: number;
	/** of planned, the splats not resident yet */
	missing: number;
}

interface Measure {
	/** on screen at margin 1 */
	shown: boolean;
	/** on screen now or ahead, at margin 1 */
	near: boolean;
	pixels: number;
	weight: number;
}

interface Step {
	page: PageNode;
	shown: boolean;
	/** refined last plan and on screen within HOLD: the quadrants it handed down stay */
	held: number | null;
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
		const refined = new Map<number, number>();
		const seen = new Map<number, number>();
		const priority = new Map<number, number>();
		const queue = new Queue();
		let planned = 0;
		let kept = 0;
		const near = new Set<number>();
		const shown = new Set<number>();

		const enter = (page: PageNode, m: Measure) => {
			const count = page.row.count;
			order.push(page);
			kept += slots(count);
			if (m.shown) {
				planned += count;
				shown.add(page.id);
			}
			if (m.near) near.add(page.id);
			const handed = this.#refined.get(page.id);
			const was = handed !== undefined;
			const target = m.pixels * m.weight;
			// rank by need alone: ranked up by the margin, it would meet the budget before what freed it
			const ratio = target / Math.max(1, count);
			if (m.pixels > 0) priority.set(page.id, ratio);
			const recent = now - (this.#seen.get(page.id) ?? -Infinity) <= HOLD;
			const held = was && !m.shown && recent ? handed : null;
			if ((count < target * (was ? MARGIN : 1) || held !== null) && refinable(page, resident))
				queue.push({ page, shown: m.shown, held, ratio });
		};

		for (const root of tree.roots) enter(root, this.#measure(root, view, predicted));
		// once a refinement on screen misses the budget, only off-screen ones go on
		let full = false;
		while (queue.size) {
			const { page, shown, held } = queue.pop();
			// quadrants off even the fringe stay with the page, which draws them unseen, so off budget
			const parts: { child: PageNode; m: Measure }[] = [];
			let quadrants = 0;
			page.children.forEach((child, q) => {
				if (!child) return;
				const m = this.#measure(child, view, predicted);
				if (m.pixels <= 0 && !((held ?? 0) & (1 << q))) return;
				parts.push({ child, m });
				quadrants |= 1 << q;
			});
			if (!parts.length) continue;
			let grow = 0;
			let delta = shown ? -page.row.count : 0;
			for (const { child, m } of parts) {
				grow += slots(child.row.count);
				if (m.shown) delta += child.row.count;
			}
			if (kept + grow > capacity) break;
			if (delta > 0 && (full || planned + delta > budget)) {
				full = true;
				continue;
			}
			refined.set(page.id, quadrants);
			const last = shown ? now : this.#seen.get(page.id);
			if (last !== undefined) seen.set(page.id, last);
			if (shown) planned -= page.row.count;
			for (const { child, m } of parts) enter(child, m);
		}
		this.#refined = refined;
		this.#seen = seen;

		const cut = order.filter((page) => !refined.has(page.id));
		const keep = new Set(refined.keys());
		for (const page of cut) keep.add(page.id);
		const ranked: { wanted: Wanted; rank: number }[] = [];
		for (const wanted of tree.wanted()) {
			let rank = -1;
			for (const page of wanted.over) rank = Math.max(rank, priority.get(page.id) ?? -1);
			if (rank >= 0) ranked.push({ wanted, rank });
		}
		ranked.sort((a, b) => b.rank - a.rank);
		let missing = 0;
		for (const page of cut) if (shown.has(page.id) && !resident(page.id)) missing += page.row.count;
		return {
			cut,
			// fringe last: it holds up the screen's pages in the workers, and its uploads cost moving frames
			load: cut.filter(
				(page) => !resident(page.id) && (near.has(page.id) || (!predicted && missing === 0))
			),
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
		return { shown, near, pixels, weight };
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
