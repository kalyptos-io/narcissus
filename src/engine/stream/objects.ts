// the host's object ids: each unit's .ids, read once through the engine's source and written into
// its pages as they arrive

import { GEOMETRY_WORDS, parseIds, type DecodedPage, type PageRow } from '../../format/index.ts';
import type { Fetch } from '../../ports.ts';

export class Objects {
	#urls: Map<string, string>;
	#fetch: Fetch;
	#onLoad: () => void;
	/** by pack path: each page's ids by blob offset, null when ignored, undefined while loading */
	// ponytail: kept for the world's life, bounded by the host's map
	#packs = new Map<string, Map<number, Uint16Array> | null | undefined>();

	/** urls: a unit's pack path to the url of its .ids; onLoad runs when one settles */
	constructor(urls: Readonly<Record<string, string>>, fetch: Fetch, onLoad: () => void) {
		this.#urls = new Map(Object.entries(urls));
		this.#fetch = fetch;
		this.#onLoad = onLoad;
	}

	/** whether the pages of pack may load: it has no .ids, or its .ids settled; starts loading it */
	ready(pack: string, rows: readonly PageRow[]): boolean {
		const url = this.#urls.get(pack);
		if (url === undefined) return true;
		if (this.#packs.has(pack)) return this.#packs.get(pack) !== undefined;
		this.#packs.set(pack, undefined);
		void this.#fetch(url, null)
			.then(parseIds)
			.then((ids) => slices(ids, rows))
			.catch((error: unknown) => {
				console.warn(
					`${url} is ignored: ${error instanceof Error ? error.message : String(error)}`
				);
				return null;
			})
			.then((pages) => {
				this.#packs.set(pack, pages);
				this.#onLoad();
			});
		return false;
	}

	/** the ids of the page at blob offset of pack into bits 16-31 of its geometry word 3 */
	write(pack: string, offset: number, page: DecodedPage): void {
		const ids = this.#packs.get(pack)?.get(offset);
		if (!ids) return;
		const { geometry } = page;
		for (let t = 0; t < page.count; t++) geometry[t * GEOMETRY_WORDS + 3] |= ids[t] << 16;
	}
}

/** ids cut into the pages of rows, in blob order; throws when they hold another count of splats */
function slices(ids: Uint16Array, rows: readonly PageRow[]): Map<number, Uint16Array> {
	const ordered = rows.toSorted((a, b) => a.offset - b.offset);
	const splats = ordered.reduce((sum, row) => sum + row.count, 0);
	if (ids.length !== splats) throw new Error(`it holds ${ids.length} ids for ${splats} splats`);
	const pages = new Map<number, Uint16Array>();
	let first = 0;
	for (const { offset, count } of ordered) {
		pages.set(offset, ids.subarray(first, first + count));
		first += count;
	}
	return pages;
}
