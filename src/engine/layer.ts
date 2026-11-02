// layers: splat sets a host adds beside the world, drawn and sorted with it

import { decodePage, inflate, packRows, type DecodedPage } from '../format/index.ts';
import { slots } from './gpu/layout.ts';
import type { Pool } from './gpu/pool.ts';
import { boxVisible } from './math/frustum.ts';
import type { Box, Drawn, Point } from './types.ts';

export interface Layer {
	/** splats it draws */
	readonly splats: number;
	/** world extent of its splats' 3-sigma boxes */
	readonly box: Box;
	/** a hidden layer costs no frame time; its pages stay on the gpu, so it shows again at once */
	visible: boolean;
	/** 0 to 1, of every splat */
	opacity: number;
	/** frees its pages; the handle then does nothing */
	remove(): void;
}

export interface LayerPage {
	page: DecodedPage;
	/** world min e, n, h then max e, n, h of its splats' extents */
	box: Float64Array;
}

/**
 * the pages of a pack whose positions count from origin, the south-west corner; only its finest
 * level, as a layer draws at full detail at every distance
 */
export async function layerPages(
	pack: Uint8Array,
	origin: readonly [number, number]
): Promise<LayerPage[]> {
	const rows = await packRows(async (start, end) => pack.subarray(start, end), pack.length);
	if (rows.length === 0) throw new Error('the pack holds no pages');
	const g = Math.min(...rows.map((row) => row.g));
	return Promise.all(
		rows
			.filter((row) => row.g === g)
			.map(async (row) => {
				const payload = await inflate(pack.subarray(row.offset, row.offset + row.length));
				const box = Float64Array.from(row.box, (v, k) => v + (k % 3 < 2 ? origin[k % 3] : 0));
				return { page: decodePage(payload, null), box };
			})
	);
}

/** the extent of page boxes as layerPages gives them */
export function boxOf(boxes: Float64Array[]): Box {
	const span = (a: number): [number, number] => [
		Math.min(...boxes.map((b) => b[a])),
		Math.max(...boxes.map((b) => b[a + 3]))
	];
	return { e: span(0), n: span(1), h: span(2) };
}

/** pool splats the pages of a layer pin */
export function pins(pages: readonly LayerPage[]): number {
	return pages.reduce((sum, { page }) => sum + slots(page.count), 0);
}

interface Shown {
	layer: Layer;
	pages: { id: number; count: number; box: Float64Array }[];
}

/** Drawn factors of a layer's pages, every quadrant at its opacity; 0 while it draws nothing */
function factors({ visible, opacity }: Layer): number {
	return visible ? (Math.round(opacity * 255) * 0x01010101) >>> 0 : 0;
}

/** the layers of an engine, their pages pinned in its pool */
export class Layers {
	#pool: Pool;
	#keep: (id: number) => boolean;
	#changed: () => void;
	#shown = new Map<number, Shown>();
	#count = 0;
	/** layer page ids count down from -1, apart from the tree's */
	#page = 0;
	#pinned = 0;
	#numbers = new WeakMap<Layer, number>();

	/** keep: the pool pages a layer page may not evict; changed: what draws, or its budget, changed */
	constructor(pool: Pool, keep: (id: number) => boolean, changed: () => void) {
		this.#pool = pool;
		this.#keep = keep;
		this.#changed = changed;
	}

	/** pool splats the layers' pages pin */
	get pinned(): number {
		return this.#pinned;
	}

	/** a layer of pages whose positions count from origin; null when the pool cannot hold them */
	add(pages: readonly LayerPage[], origin: readonly [number, number]): Layer | null {
		const pinned = pins(pages);
		this.#pinned += pinned;
		const number = ++this.#count;
		const changed = this.#changed;
		let visible = true;
		let opacity = 1;
		const live = () => this.#shown.has(number);
		const remove = () => {
			if (!this.#shown.delete(number)) return;
			for (const { id } of shown.pages) this.#pool.remove(id);
			this.#pinned -= pinned;
			changed();
		};
		const layer: Layer = {
			splats: pages.reduce((sum, { page }) => sum + page.count, 0),
			box: boxOf(pages.map(({ box }) => box)),
			get visible() {
				return visible;
			},
			set visible(on: boolean) {
				if (!live()) return;
				visible = on;
				changed();
			},
			get opacity() {
				return opacity;
			},
			set opacity(value: number) {
				if (!live()) return;
				opacity = Math.min(1, Math.max(0, value));
				changed();
			},
			remove
		};
		const shown: Shown = { layer, pages: [] };
		this.#shown.set(number, shown);
		for (const { page, box } of pages) {
			const id = --this.#page;
			if (!this.#pool.add(id, page, origin, this.#keep, number)) {
				remove();
				return null;
			}
			shown.pages.push({ id, count: page.count, box });
		}
		changed();
		this.#numbers.set(layer, number);
		return layer;
	}

	/** the pool's number of a layer shown here */
	numberOf(layer: Layer): number | undefined {
		return this.#numbers.get(layer);
	}

	/** the layer the pool numbers so, null for the world or a layer removed */
	layerOf(number: number): Layer | null {
		return this.#shown.get(number)?.layer ?? null;
	}

	/** splats of the visible layers' pages in view of planes in the floating-origin frame at origin */
	inView(planes: Float32Array, origin: Point): number {
		const min = [0, 0, 0];
		const max = [0, 0, 0];
		let sum = 0;
		for (const { layer, pages } of this.#shown.values()) {
			if (!factors(layer)) continue;
			for (const { count, box } of pages) {
				for (let a = 0; a < 3; a++) {
					min[a] = box[a] - origin[a];
					max[a] = box[a + 3] - origin[a];
				}
				if (boxVisible(planes, min, max)) sum += count;
			}
		}
		return sum;
	}

	/** the pages of the layers that draw */
	drawn(): Drawn[] {
		const drawn: Drawn[] = [];
		for (const { layer, pages } of this.#shown.values()) {
			const f = factors(layer);
			if (f) for (const { id } of pages) drawn.push({ id, factors: f });
		}
		return drawn;
	}

	/** forgets every layer, its pages left in the pool; the handles then do nothing */
	clear(): void {
		this.#shown.clear();
	}
}
