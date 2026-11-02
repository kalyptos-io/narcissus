// layers: splat sets a host adds beside the world, drawn and sorted with it

import {
	decodePage,
	GEOMETRY_WORDS,
	inflate,
	packRows,
	PARAMS,
	type DecodedPage
} from '../format/index.ts';
import type { Fetch } from '../ports.ts';
import { slots } from './gpu/layout.ts';
import type { Pool } from './gpu/pool.ts';
import { boxVisible } from './math/frustum.ts';
import type { Box, Drawn, Point } from './types.ts';

/**
 * a pack, or the url the engine's source reads it from, and how it shows; its anchor is the centre
 * of its box as encoded, at the height of its lowest splat centre, and a splat encoded at p shows
 * at position + R(heading) (p - anchor)
 */
export type LayerOptions = ({ url: string } | { bytes: Uint8Array }) & {
	/** the pack's south-west corner, as encodeLayer gives it */
	origin: readonly [e: number, n: number];
	/** where the anchor sits; where it was encoded when left out */
	position?: Point;
	/** degrees clockwise seen from above, as a pose's yaw, about the vertical through position */
	heading?: number;
	visible?: boolean;
	opacity?: number;
	pickable?: boolean;
	/** aborts the read; addLayer then rejects with its reason */
	signal?: AbortSignal;
};

/** a field set shows at the next frame; after remove(), setters do nothing and getters stay */
export interface Layer {
	/** splats it draws */
	readonly splats: number;
	/** world extent of its splats' 3-sigma boxes where it stands; a turned one's errs a little wide */
	readonly box: Box;
	/** where its anchor sits */
	position: Point;
	/** degrees clockwise about the vertical through position */
	heading: number;
	/** a hidden layer costs no frame time; its pages stay on the gpu, so it shows again at once */
	visible: boolean;
	/** 0 to 1, of every splat */
	opacity: number;
	/** whether pick finds its splats; one that does not lets pick through to what lies behind */
	pickable: boolean;
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

/**
 * the pages of the layer options give, its pack read through fetch for a url; the options are
 * checked first, and the signal again once the pages are decoded
 */
export async function readLayer(options: LayerOptions, fetch: Fetch): Promise<LayerPage[]> {
	checkLayer(options);
	const { signal } = options;
	const pack = 'bytes' in options ? options.bytes : await fetch(options.url, null, signal);
	const pages = await layerPages(pack, options.origin);
	signal?.throwIfAborted();
	return pages;
}

/** the extent of page boxes as layerPages gives them */
export function boxOf(boxes: Float64Array[]): Box {
	const span = (a: number): [number, number] => [
		Math.min(...boxes.map((b) => b[a])),
		Math.max(...boxes.map((b) => b[a + 3]))
	];
	return { e: span(0), n: span(1), h: span(2) };
}

/** world height of the lowest splat centre of pages, decoded as position() in the shader does */
function lowest(pages: readonly LayerPage[]): number {
	let low = Infinity;
	for (const { page } of pages) {
		let q = Infinity;
		for (let t = 0; t < page.count; t++) {
			q = Math.min(q, page.geometry[t * GEOMETRY_WORDS + 1] & 0xffff);
		}
		low = Math.min(low, page.params[PARAMS.origin + 2] + q * page.params[PARAMS.step + 2]);
	}
	return low;
}

/** pool splats the pages of a layer pin */
export function pins(pages: readonly LayerPage[]): number {
	return pages.reduce((sum, { page }) => sum + slots(page.count), 0);
}

/** a layer page as Layers keeps it once the pool holds its records */
interface Kept {
	id: number;
	count: number;
	/** world origin as encoded */
	base: readonly [number, number, number];
	/** DecodedPage.clusters as encoded */
	clusters: Float32Array;
	/** world min e, n, h then max e, n, h of its splats' extents as placed */
	box: Float64Array;
}

interface Shown {
	layer: Layer;
	pages: Kept[];
	/** places the pages where the layer stands, once however often it moved or turned since */
	settle(): void;
}

const DEG = Math.PI / 180;

/** throws a RangeError naming the first field of options out of range */
function checkLayer({ origin, position, heading, opacity }: LayerOptions): void {
	if (origin.length !== 2 || !origin.every(Number.isFinite)) {
		throw new RangeError("A layer's origin must be two finite numbers.");
	}
	if (position !== undefined) checkPosition(position);
	if (heading !== undefined) checkHeading(heading);
	if (opacity !== undefined) checkOpacity(opacity);
}

function checkPosition(position: Point): Point {
	if (position.length !== 3 || !position.every(Number.isFinite)) {
		throw new RangeError("A layer's position must be three finite numbers.");
	}
	return [position[0], position[1], position[2]];
}

function checkHeading(heading: number): number {
	if (!Number.isFinite(heading)) throw new RangeError("A layer's heading must be a finite number.");
	return heading;
}

function checkOpacity(opacity: number): number {
	if (!(opacity >= 0 && opacity <= 1)) {
		throw new RangeError("A layer's opacity must be a number from 0 to 1.");
	}
	return opacity;
}

/**
 * page placed with its layer's anchor at position, turned by (cos, sin) about it: its origin and
 * its clusters' boxes from there, as Pool.place takes them; its world box into page.box
 */
function place(
	page: Kept,
	anchor: Point,
	position: Point,
	[c, s]: readonly [number, number]
): { base: [number, number, number]; boxes: Float32Array<ArrayBuffer> } {
	const x = page.base[0] - anchor[0];
	const y = page.base[1] - anchor[1];
	const base: [number, number, number] = [
		position[0] + c * x + s * y,
		position[1] + c * y - s * x,
		position[2] + page.base[2] - anchor[2]
	];
	const { clusters, box } = page;
	const boxes = new Float32Array(clusters.length);
	box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
	for (let k = 0; k < clusters.length; k += 6) {
		// the turned box's centre, and its half sides grown to hold the turned corners
		const mx = (clusters[k] + clusters[k + 3]) / 2;
		const my = (clusters[k + 1] + clusters[k + 4]) / 2;
		const hx = (clusters[k + 3] - clusters[k]) / 2;
		const hy = (clusters[k + 4] - clusters[k + 1]) / 2;
		const centre = [c * mx + s * my, c * my - s * mx];
		const half = [Math.abs(c) * hx + Math.abs(s) * hy, Math.abs(s) * hx + Math.abs(c) * hy];
		for (let a = 0; a < 3; a++) {
			const lo = a < 2 ? centre[a] - half[a] : clusters[k + 2];
			const hi = a < 2 ? centre[a] + half[a] : clusters[k + 5];
			boxes[k + a] = lo;
			boxes[k + 3 + a] = hi;
			box[a] = Math.min(box[a], base[a] + lo);
			box[a + 3] = Math.max(box[a + 3], base[a] + hi);
		}
	}
	return { base, boxes };
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

	/** a layer of pages placed as options say, as readLayer checked them; null when the pool is full */
	add(pages: readonly LayerPage[], options: LayerOptions): Layer | null {
		const pinned = pins(pages);
		this.#pinned += pinned;
		const number = ++this.#count;
		const pool = this.#pool;
		const changed = this.#changed;
		const encoded = boxOf(pages.map(({ box }) => box));
		const anchor: Point = [
			(encoded.e[0] + encoded.e[1]) / 2,
			(encoded.n[0] + encoded.n[1]) / 2,
			lowest(pages)
		];
		let position = options.position ? checkPosition(options.position) : anchor;
		let { heading = 0, visible = true, opacity = 1, pickable = true } = options;
		let moved = true;
		const kept: Kept[] = [];
		const live = () => this.#shown.has(number);
		const move = () => {
			moved = true;
			changed();
		};
		const settle = () => {
			if (!moved) return;
			moved = false;
			const turn = [Math.cos(heading * DEG), Math.sin(heading * DEG)] as const;
			for (const page of kept) {
				const { base, boxes } = place(page, anchor, position, turn);
				pool.place(page.id, base, turn, boxes);
			}
		};
		const remove = () => {
			if (!this.#shown.delete(number)) return;
			this.#numbers.delete(layer);
			for (const { id } of kept) pool.remove(id);
			this.#pinned -= pinned;
			changed();
		};
		const layer: Layer = {
			splats: pages.reduce((sum, { page }) => sum + page.count, 0),
			get box() {
				settle();
				return boxOf(kept.map(({ box }) => box));
			},
			get position() {
				return position;
			},
			set position(value: Point) {
				if (!live()) return;
				position = checkPosition(value);
				move();
			},
			get heading() {
				return heading;
			},
			set heading(value: number) {
				if (!live()) return;
				heading = checkHeading(value);
				move();
			},
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
				opacity = checkOpacity(value);
				changed();
			},
			get pickable() {
				return pickable;
			},
			set pickable(on: boolean) {
				if (!live()) return;
				pickable = on;
				for (const { id } of kept) pool.setPickable(id, on);
				changed();
			},
			remove
		};
		this.#shown.set(number, { layer, pages: kept, settle });
		const o = PARAMS.origin;
		const { origin } = options;
		for (const { page } of pages) {
			const id = --this.#page;
			if (!pool.add(id, page, origin, this.#keep, number)) {
				remove();
				return null;
			}
			if (!pickable) pool.setPickable(id, false);
			const base = [
				page.params[o] + origin[0],
				page.params[o + 1] + origin[1],
				page.params[o + 2]
			] as const;
			kept.push({ id, count: page.count, base, clusters: page.clusters, box: new Float64Array(6) });
		}
		settle();
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
		for (const { layer, pages, settle } of this.#shown.values()) {
			if (!factors(layer)) continue;
			settle();
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
		for (const { layer, pages, settle } of this.#shown.values()) {
			const f = factors(layer);
			if (!f) continue;
			settle();
			for (const { id } of pages) drawn.push({ id, factors: f });
		}
		return drawn;
	}

	/** forgets every layer, its pages left in the pool; the handles then do nothing */
	clear(): void {
		this.#shown.clear();
		this.#numbers = new WeakMap();
	}
}
