// the cut as drawn pages and quadrant opacities, cross-fading where it changes

import { PAGE_SIDE, type PageRow } from '../../format/index.ts';
import { slots } from '../gpu/layout.ts';
import type { Drawn } from '../types.ts';
import type { PageNode } from '../world/tree.ts';

export const FADE_MS = 250;
/** share of the budget fading splats, and the pool slots of pages held for them, may take */
export const FADE_CAP = 0.25;

/** one page quadrant that draws, or drew and is held while its area fades in under others */
interface Entry {
	page: PageNode;
	q: number;
	/** the quadrant's square on the global grid of level g - 1 */
	level: number;
	col: number;
	row: number;
	cell: number;
	splats: number;
	/** ramp start; null once opaque, or while held */
	start: number | null;
	/** the factor a held drawer keeps */
	frozen: number;
	held: boolean;
}

export class Fader {
	/** by page id * 4 + quadrant */
	#entries = new Map<number, Entry>();

	/**
	 * every resident page that draws a quadrant: a cut page draws itself where resident, else its
	 * nearest resident ancestor draws the quadrant over it; fading is true while any opacity moves
	 */
	update(
		cut: PageNode[],
		resident: (id: number) => boolean,
		now: number,
		budget: number
	): { drawn: Drawn[]; fading: boolean } {
		const entries = this.#entries;
		const cover = covering(cut, resident);
		let top = -1;

		// finish ramps; quadrants that left the cover keep their factor
		for (const [key, e] of entries) {
			if (!resident(e.page.id)) {
				entries.delete(key);
				continue;
			}
			top = Math.max(top, e.level);
			if (e.held) continue;
			if (e.start !== null && now - e.start >= FADE_MS) e.start = null;
			if (!cover.has(key)) {
				e.frozen = factor(e, now);
				e.start = null;
				e.held = true;
			}
		}
		const fresh = new Set<Entry>();
		for (const [key, page] of cover) {
			const e = entries.get(key);
			if (!e) {
				const added = entry(page, key % 4, now);
				top = Math.max(top, added.level);
				entries.set(key, added);
				fresh.add(added);
			} else if (e.held) {
				e.held = false;
				if (e.frozen < 255) {
					e.start = now - (e.frozen / 255) * FADE_MS;
					fresh.add(e);
				}
			}
		}

		// a held drawer stays while a ramp over any part of its area runs
		const outs = new Map<number, Entry>();
		const under = new Map<number, Entry[]>();
		for (const e of entries.values()) {
			if (!e.held) continue;
			outs.set(e.cell, e);
			for (let l = e.level, c = e.col, r = e.row; l <= top; l++, c >>= 1, r >>= 1) {
				const k = cellKey(l, c, r);
				const list = under.get(k);
				if (list) list.push(e);
				else under.set(k, [e]);
			}
		}
		const overlapping = (e: Entry): Entry[] => {
			const found = [...(under.get(e.cell) ?? [])];
			for (let l = e.level + 1, c = e.col >> 1, r = e.row >> 1; l <= top; l++, c >>= 1, r >>= 1) {
				const out = outs.get(cellKey(l, c, r));
				if (out) found.push(out);
			}
			return found;
		};
		const holding = new Set<Entry>();
		// pages held only for a fade sit in the pool beside the plan's, which leaves the cap free
		const pinned = new Set<PageNode>();
		let spent = 0;
		let pinnedSlots = 0;
		const pin = (page: PageNode) => {
			if (pinned.has(page)) return;
			pinned.add(page);
			pinnedSlots += slots(page.row.count);
		};
		for (const e of entries.values()) {
			if (e.held || e.start === null || fresh.has(e)) continue;
			spent += e.splats;
			for (const out of overlapping(e)) {
				if (holding.has(out)) continue;
				holding.add(out);
				spent += out.splats;
				pin(out.page);
			}
		}
		const cap = FADE_CAP * budget;
		for (const e of fresh) {
			const extra = overlapping(e).filter((out) => !holding.has(out));
			const cost = extra.reduce((sum, out) => sum + out.splats, e.splats);
			const pages = new Set(extra.map((out) => out.page).filter((page) => !pinned.has(page)));
			const more = [...pages].reduce((sum, page) => sum + slots(page.row.count), 0);
			if (spent + cost > cap || pinnedSlots + more > cap) {
				e.start = null;
				continue;
			}
			spent += cost;
			for (const out of extra) holding.add(out);
			for (const page of pages) pin(page);
		}
		const drawn = new Map<number, Drawn>();
		let fading = false;
		for (const [key, e] of entries) {
			if (e.held && !holding.has(e)) {
				entries.delete(key);
				continue;
			}
			if (e.held || e.start !== null) fading = true;
			const f = factor(e, now);
			if (!f) continue;
			const d = drawn.get(e.page.id);
			if (d) d.factors = (d.factors | (f << (8 * e.q))) >>> 0;
			else drawn.set(e.page.id, { id: e.page.id, factors: (f << (8 * e.q)) >>> 0 });
		}
		return { drawn: [...drawn.values()], fading };
	}
}

/** the static cover: the page of every quadrant that draws, by page id * 4 + quadrant */
function covering(cut: PageNode[], resident: (id: number) => boolean): Map<number, PageNode> {
	const ends = new Set(cut);
	const planned = new Set<PageNode>();
	const roots: PageNode[] = [];
	for (const page of cut) {
		for (let p: PageNode | null = page; p && !planned.has(p); p = p.parent) {
			planned.add(p);
			if (!p.parent) roots.push(p);
		}
	}
	const cover = new Map<number, PageNode>();
	const descend = (page: PageNode) => {
		for (let q = 0; q < 4; q++) {
			const child = page.children[q];
			// an empty quadrant hides once its page is refined past it
			if (child && resident(child.id) && planned.has(child)) {
				descend(child);
			} else if (child !== null || ends.has(page)) {
				cover.set(page.id * 4 + q, page);
			}
		}
	};
	for (const root of roots) if (resident(root.id)) descend(root);
	return cover;
}

function entry(page: PageNode, q: number, now: number): Entry {
	const side = PAGE_SIDE * 2 ** page.g;
	const level = page.g - 1;
	const col = 2 * (Math.round(page.unit.e / side) + page.row.i) + (q & 1);
	const row = 2 * (Math.round(page.unit.n / side) + page.row.j) + (q >> 1);
	return {
		page,
		q,
		level,
		col,
		row,
		cell: cellKey(level, col, row),
		splats: quadrantSplats(page.row, q),
		start: now,
		frozen: 0,
		held: false
	};
}

const cellKey = (level: number, col: number, row: number) =>
	((level + 1) * 2 ** 21 + col) * 2 ** 21 + row;

function quadrantSplats({ count, quadrants }: PageRow, q: number): number {
	return (q < 3 ? quadrants[q] : count) - (q > 0 ? quadrants[q - 1] : 0);
}

function factor(e: Entry, now: number): number {
	if (e.held) return e.frozen;
	if (e.start === null) return 255;
	return Math.min(255, Math.round(((now - e.start) / FADE_MS) * 255));
}
