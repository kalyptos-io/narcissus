// a stream worker: fetch, cache, inflate, decode; see jobs.ts

import { Missing, type Cache } from '../../ports.ts';
import type { Col, DecodedPage, Idx } from '../../format/index.ts';
import { http } from '../../adapters/http.ts';
import { loadBatch, loadIdx, type Sources } from './jobs.ts';
import type { LoaderOptions } from './loader.ts';
import { memoryCache } from '../../adapters/memory.ts';
import { opfsCache, pruneOpfs } from '../../adapters/opfs.ts';
import { asking, type Ask, type Fetched } from './remote.ts';
import type { Batch } from './scheduler.ts';
import { synthetic } from './synthetic.ts';

export interface Init extends Pick<LoaderOptions, 'base' | 'cache'> {
	/** page is the page's own Fetch, asked by message */
	source: 'http' | 'synthetic' | 'page';
	/** the cache shard this worker owns, of shards */
	shard: number;
	shards: number;
}

export type Message =
	| ({ type: 'init' } & Init)
	| { type: 'idx'; id: number; path: string }
	| { type: 'batch'; id: number; batch: Batch }
	| { type: 'abort'; id: number };

export type Loaded = { id: number; page: DecodedPage };

/** a batch answers with its pages one by one, then done */
export type Reply =
	| { id: number; value: Idx }
	| { id: number; page: Loaded }
	| { id: number; done: true }
	| { id: number; error: string; missing: boolean };

const MiB = 2 ** 20;

// the dom lib has no worker scope types
const scope = self as unknown as {
	onmessage: (event: MessageEvent<Message | Fetched>) => void;
	postMessage(message: Reply | Ask, transfer: Transferable[]): void;
};

let sources: Promise<Sources> | undefined;
const cols = new Map<string, Promise<Col>>();
const running = new Map<number, AbortController>();
const own = asking((ask) => scope.postMessage(ask, []));

scope.onmessage = ({ data }) => {
	if ('fetched' in data) {
		own.take(data);
	} else if (data.type === 'init') {
		sources = open(data);
		sources.catch(() => undefined);
	} else if (data.type === 'abort') {
		running.get(data.id)?.abort();
	} else {
		void answer(data);
	}
};

async function open(init: Init): Promise<Sources> {
	if (init.source === 'synthetic') {
		return {
			fetch: synthetic(),
			cache: await openCache({ ...init, cache: 'none' }),
			base: init.base
		};
	}
	const fetch = init.source === 'page' ? own.fetch : http;
	return { fetch, cache: await openCache(init), base: init.base };
}

async function openCache({ cache, shard, shards }: Init): Promise<Cache> {
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

async function answer(message: Extract<Message, { type: 'idx' | 'batch' }>) {
	const { id } = message;
	const controller = new AbortController();
	running.set(id, controller);
	try {
		if (!sources) throw new Error('stream worker used before init');
		const ready = await sources;
		if (message.type === 'idx') {
			scope.postMessage({ id, value: await loadIdx(ready, message.path) }, []);
		} else {
			for await (const page of loadBatch(ready, message.batch, cols, controller.signal)) {
				scope.postMessage({ id, page }, transfers(page));
			}
			scope.postMessage({ id, done: true }, []);
		}
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		// an error's class does not cross to the page, so missing goes beside its message
		scope.postMessage({ id, error: text, missing: error instanceof Missing }, []);
	} finally {
		running.delete(id);
	}
}

function transfers({ page }: Loaded): Transferable[] {
	// two arrays of one page may share a buffer, and a buffer may be listed once only
	const buffers = new Set<ArrayBuffer>();
	const { counts, centres, radii, links } = page.nodes;
	const arrays = [
		page.geometry,
		page.colour,
		page.params,
		page.clusters,
		counts,
		centres,
		radii,
		links
	];
	for (const array of arrays) buffers.add(array.buffer);
	return [...buffers];
}
