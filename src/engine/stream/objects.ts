// the host's object ids: each unit's .ids, read once through the stream workers and written into
// its pages as they arrive

import { GEOMETRY_WORDS, type DecodedPage, type Idx, type PageRow } from '../../format/index.ts';
import type { UnitFile } from './scheduler.ts';

/** a unit's ids at url by the blob offsets of its pages, given its pack and the rows of its .idx */
export type LoadIds = (
	url: string,
	pack: UnitFile,
	rows: readonly PageRow[]
) => Promise<Map<number, Uint16Array>>;

export class Objects {
	#urls: Map<string, string>;
	#load: LoadIds;
	#onLoad: () => void;
	/** by pack path: each page's ids by blob offset, null when ignored, undefined while loading */
	// ponytail: kept for the world's life, bounded by the host's map
	#packs = new Map<string, Map<number, Uint16Array> | null | undefined>();

	/** urls: a unit's pack path to the url of its .ids; onLoad runs when one settles */
	constructor(urls: Readonly<Record<string, string>>, load: LoadIds, onLoad: () => void) {
		this.#urls = new Map(Object.entries(urls));
		this.#load = load;
		this.#onLoad = onLoad;
	}

	/** whether the pages of pack, of the unit of idx, may load: it has no .ids, or its .ids settled; starts loading it */
	ready(pack: string, idx: Idx): boolean {
		const url = this.#urls.get(pack);
		if (url === undefined) return true;
		if (this.#packs.has(pack)) return this.#packs.get(pack) !== undefined;
		this.#packs.set(pack, undefined);
		void this.#load(url, { path: pack, size: idx.packSize }, idx.rows)
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
