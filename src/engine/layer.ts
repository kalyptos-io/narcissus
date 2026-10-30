// layers: splat sets a host adds beside the world, drawn and sorted with it

import { decodePage, inflate, packRows, type DecodedPage } from '../format/index.ts';
import type { Box } from './types.ts';

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
