// the main thread's side of the stream workers: one set per engine, a Loader per world over them

import { rethrown, type Fetch } from '../../ports.ts';
import type { Idx, PageRow } from '../../format/index.ts';
import type { Wanted } from './attributes.ts';
import { answering, type Ask } from './remote.ts';
import type { Batch, UnitFile } from './scheduler.ts';
import type { Loaded, Message, Reply, Request } from './serve.ts';
// inline, so the built engine is one file that needs no path to its worker
import StreamWorker from './worker.ts?worker&inline';

export interface LoaderOptions {
	workers: number;
	cache: 'opfs' | 'memory' | 'none';
	/** the page's own Fetch, which stays on the main thread and the workers ask by message; http otherwise */
	page?: Fetch;
	/** a new stream worker; the synthetic world's comes from its own module */
	spawn?: () => Worker;
}

interface Slot {
	worker: Worker;
	error?: Error;
}

interface Pending {
	slot: Slot;
	/** a batch's pages as they come */
	page?(loaded: Loaded): void;
	resolve(value?: Idx | Map<number, Uint16Array>): void;
	reject(error: Error): void;
}

/** one world's requests, its paths relative to base, the url of its directory ending in / */
export class Loader {
	#workers: Workers;
	#base: string;

	constructor(workers: Workers, base: string) {
		this.#workers = workers;
		this.#base = base;
	}

	idx(path: string): Promise<Idx> {
		const request = { type: 'idx', id: this.#workers.id(), base: this.#base, path } as const;
		return this.#workers.send(0, request) as Promise<Idx>;
	}

	/** a unit's object ids by the blob offsets of its pages, as jobs.ts loadIds gives them */
	ids(url: string, pack: UnitFile, rows: readonly PageRow[]): Promise<Map<number, Uint16Array>> {
		const request = {
			type: 'ids',
			id: this.#workers.id(),
			base: this.#base,
			url,
			pack,
			rows
		} as const;
		return this.#workers.send(this.#workers.shard(pack.path), request) as Promise<
			Map<number, Uint16Array>
		>;
	}

	/**
	 * page takes each page once decoded, with its chunks of streams; rejects with an AbortError
	 * when signal aborts
	 */
	batch(
		batch: Batch,
		streams: readonly Wanted[],
		signal: AbortSignal,
		page: (loaded: Loaded) => void
	): Promise<void> {
		if (signal.aborted) return Promise.reject(aborted());
		const slot = this.#workers.shard(`${batch.pack}#${batch.window}`);
		const request = {
			type: 'batch',
			id: this.#workers.id(),
			base: this.#base,
			batch,
			streams
		} as const;
		return this.#workers.send(slot, request, signal, page) as Promise<void>;
	}
}

/** the stream workers, each owning a shard of the cache */
export class Workers {
	#slots: Slot[];
	#pending = new Map<number, Pending>();
	#id = 0;

	constructor(options: LoaderOptions) {
		const { cache, page, workers: shards, spawn = () => new StreamWorker() } = options;
		this.#slots = Array.from({ length: shards }, (_, shard) => {
			const worker = spawn();
			const slot: Slot = { worker };
			const answer =
				page && answering(page, (fetched, transfer) => worker.postMessage(fetched, transfer));
			worker.onmessage = ({ data }: MessageEvent<Reply | Ask>) => {
				if ('id' in data) this.#reply(data);
				else answer?.(data);
			};
			worker.onerror = () => this.#fail(slot);
			const init = {
				type: 'init',
				cache,
				source: page ? 'page' : 'http',
				shard,
				shards
			} satisfies Message;
			worker.postMessage(init);
			return slot;
		});
	}

	/** a new request id */
	id(): number {
		return ++this.#id;
	}

	/** the worker whose cache owns the pages of key */
	shard(key: string): number {
		return shardOf(key, this.#slots.length);
	}

	destroy(): void {
		for (const { worker } of this.#slots) worker.terminate();
		for (const pending of this.#pending.values()) pending.reject(aborted());
	}

	send(
		shard: number,
		request: Request,
		signal?: AbortSignal,
		page?: (loaded: Loaded) => void
	): Promise<Idx | Map<number, Uint16Array> | void> {
		const slot = this.#slots[shard];
		if (slot.error) return Promise.reject(slot.error);
		const { id } = request;
		return new Promise((resolve, reject) => {
			const settle = () => {
				this.#pending.delete(id);
				signal?.removeEventListener('abort', abort);
			};
			const abort = () => {
				settle();
				slot.worker.postMessage({ type: 'abort', id } satisfies Message);
				reject(aborted());
			};
			this.#pending.set(id, {
				slot,
				page,
				resolve: (value) => {
					settle();
					resolve(value);
				},
				reject: (error) => {
					settle();
					reject(error);
				}
			});
			signal?.addEventListener('abort', abort, { once: true });
			slot.worker.postMessage(request);
		});
	}

	#reply(reply: Reply): void {
		const pending = this.#pending.get(reply.id);
		if (!pending) return;
		if ('page' in reply) pending.page?.(reply.page);
		else if ('error' in reply) {
			pending.reject(rethrown(reply));
		} else pending.resolve('value' in reply ? reply.value : undefined);
	}

	/** a worker that failed to load never answers */
	#fail(slot: Slot): void {
		slot.error = new Error('a stream worker failed');
		for (const pending of this.#pending.values()) {
			if (pending.slot === slot) pending.reject(slot.error);
		}
	}
}

/** the worker whose cache owns the pages of a key, a pack and window: fnv-1a of it */
export function shardOf(key: string, workers: number): number {
	let hash = 0x811c9dc5;
	for (let k = 0; k < key.length; k++) {
		hash = Math.imul(hash ^ key.charCodeAt(k), 0x01000193);
	}
	return (hash >>> 0) % workers;
}

function aborted(): DOMException {
	return new DOMException('The request was aborted.', 'AbortError');
}
