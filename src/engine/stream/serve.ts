// a stream worker's body: fetch, cache, inflate, decode; see jobs.ts. worker.ts and synthetic-worker.ts run it

import { failed, type Cache, type Failed, type Fetch } from '../../ports.ts';
import type { DecodedPage, Idx, PageRow } from '../../format/index.ts';
import type { Wanted } from './attributes.ts';
import { loadBatch, loadIdx, loadIds, type Kept, type Sources } from './jobs.ts';
import type { LoaderOptions } from './loader.ts';
import { memoryCache } from '../../adapters/memory.ts';
import { opfsCache, pruneOpfs } from '../../adapters/opfs.ts';
import { asking, type Ask, type Fetched } from './remote.ts';
import type { Batch, UnitFile } from './scheduler.ts';

export interface Init extends Pick<LoaderOptions, 'cache'> {
	/** page is the page's own Fetch, asked by message */
	source: 'http' | 'page';
	/** the cache shard this worker owns, of shards */
	shard: number;
	shards: number;
}

export type Message = ({ type: 'init' } & Init) | Request | { type: 'abort'; id: number };

/** base is the url of its world's directory, ending in / */
export type Request = { id: number; base: string } & (
	| { type: 'idx'; path: string }
	| { type: 'ids'; url: string; pack: UnitFile; rows: readonly PageRow[] }
	| { type: 'batch'; batch: Batch; streams: readonly Wanted[] }
);

export type Loaded = { id: number; page: DecodedPage };

/** a batch answers with its pages one by one, then done */
export type Reply =
	| { id: number; value: Idx | Map<number, Uint16Array> }
	| { id: number; page: Loaded }
	| { id: number; done: true }
	| ({ id: number } & Failed);

const MiB = 2 ** 20;

// the dom lib has no worker scope types
const scope = self as unknown as {
	onmessage: (event: MessageEvent<Message | Fetched>) => void;
	postMessage(message: Reply | Ask, transfer: Transferable[]): void;
};

let sources: Promise<Omit<Sources, 'base'>> | undefined;
const kept: Kept = { cols: new Map(), atrs: new Map() };
const running = new Map<number, AbortController>();
const own = asking((ask) => scope.postMessage(ask, []));

/** answers the loader's messages over the sources open makes; page is the page's own Fetch */
export function serve(open: (init: Init, page: Fetch) => Promise<Omit<Sources, 'base'>>): void {
	scope.onmessage = ({ data }) => {
		if ('fetched' in data) {
			own.take(data);
		} else if (data.type === 'init') {
			sources = open(data, own.fetch);
			sources.catch(() => undefined);
		} else if (data.type === 'abort') {
			running.get(data.id)?.abort();
		} else {
			void answer(data);
		}
	};
}

export async function openCache({ cache, shard, shards }: Init): Promise<Cache> {
	if (cache === 'memory') return memoryCache(256 * MiB);
	if (cache === 'none') return { get: async () => undefined, put: async () => undefined };
	if (shard === 0) void pruneOpfs(shards);
	const bytes = (await opfsBytes()) / shards;
	return (await opfsCache(bytes, shard)) ?? memoryCache(256 * MiB);
}

/** the opfs cap over all shards: min(4 GiB, half the quota) */
async function opfsBytes(): Promise<number> {
	try {
		const { quota } = await navigator.storage.estimate();
		return Math.min(4096 * MiB, quota === undefined ? Infinity : quota / 2);
	} catch {
		return 4096 * MiB;
	}
}

async function answer(message: Request) {
	const { id } = message;
	const controller = new AbortController();
	running.set(id, controller);
	try {
		if (!sources) throw new Error('stream worker used before init');
		const ready = { ...(await sources), base: message.base };
		if (message.type === 'idx') {
			scope.postMessage({ id, value: await loadIdx(ready, message.path) }, []);
		} else if (message.type === 'ids') {
			const ids = await loadIds(ready, message.url, message.pack, message.rows);
			const buffers = new Set(Array.from(ids.values(), (page) => page.buffer as ArrayBuffer));
			scope.postMessage({ id, value: ids }, [...buffers]);
		} else {
			const { batch, streams } = message;
			for await (const page of loadBatch(ready, batch, streams, kept, controller.signal)) {
				scope.postMessage({ id, page }, transfers(page));
			}
			scope.postMessage({ id, done: true }, []);
		}
	} catch (error) {
		scope.postMessage({ id, ...failed(error) }, []);
	} finally {
		running.delete(id);
	}
}

function transfers({ page }: Loaded): Transferable[] {
	// two arrays of one page may share a buffer, and a buffer may be listed once only
	const buffers = new Set<ArrayBuffer>();
	for (const array of [page.geometry, page.colour, page.params, page.clusters]) {
		buffers.add(array.buffer);
	}
	for (const { words } of page.attributes ?? []) buffers.add(words.buffer);
	return [...buffers];
}
