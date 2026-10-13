// the main thread's side of the stream workers

import type { Idx } from '../types.ts';
import type { Batch } from './scheduler.ts';
import type { Loaded, Message, Reply } from './worker.ts';

export interface LoaderOptions {
	/** url of world.json's directory, ending in / */
	base: string;
	workers: number;
	cache: 'opfs' | 'memory' | 'none';
	source: 'http' | 'synthetic';
}

interface Slot {
	worker: Worker;
	error?: Error;
}

interface Pending {
	slot: Slot;
	/** a batch's pages as they come */
	page?(loaded: Loaded): void;
	resolve(value?: Idx): void;
	reject(error: Error): void;
}

export class Loader {
	#slots: Slot[];
	#pending = new Map<number, Pending>();
	#id = 0;

	constructor(options: LoaderOptions) {
		const { base, cache, source } = options;
		const shards = Math.max(1, options.workers);
		this.#slots = Array.from({ length: shards }, (_, shard) => {
			const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
			const slot: Slot = { worker };
			worker.onmessage = ({ data }: MessageEvent<Reply>) => this.#reply(data);
			worker.onerror = () => this.#fail(slot);
			const init = { type: 'init', base, cache, source, shard, shards } satisfies Message;
			worker.postMessage(init);
			return slot;
		});
	}

	idx(path: string): Promise<Idx> {
		const message = { type: 'idx', id: ++this.#id, path } as const;
		return this.#send(this.#slots[0], message) as Promise<Idx>;
	}

	/** page takes each page once decoded; rejects with an AbortError when signal aborts */
	batch(batch: Batch, signal: AbortSignal, page: (loaded: Loaded) => void): Promise<void> {
		if (signal.aborted) return Promise.reject(aborted());
		const slot = this.#slots[shardOf(`${batch.pack}#${batch.window}`, this.#slots.length)];
		const message = { type: 'batch', id: ++this.#id, batch } as const;
		return this.#send(slot, message, signal, page) as Promise<void>;
	}

	destroy(): void {
		for (const { worker } of this.#slots) worker.terminate();
		for (const pending of this.#pending.values()) pending.reject(aborted());
	}

	#send(
		slot: Slot,
		message: Extract<Message, { type: 'idx' | 'batch' }>,
		signal?: AbortSignal,
		page?: (loaded: Loaded) => void
	): Promise<Idx | void> {
		if (slot.error) return Promise.reject(slot.error);
		const { id } = message;
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
			slot.worker.postMessage(message);
		});
	}

	#reply(reply: Reply): void {
		const pending = this.#pending.get(reply.id);
		if (!pending) return;
		if ('page' in reply) pending.page?.(reply.page);
		else if ('error' in reply) pending.reject(new Error(reply.error));
		else pending.resolve('value' in reply ? reply.value : undefined);
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
