// a page's own Fetch, reached from the stream workers by message: a function cannot be posted

import { Missing, type Fetch } from '../../ports.ts';

/** a worker wants bytes, or wants them no more */
export type Ask =
	{ fetch: number; url: string; range: readonly [number, number] | null } | { unfetch: number };

export type Fetched =
	{ fetched: number; bytes: Uint8Array } | { fetched: number; error: string; missing: boolean };

/** the worker's side: a Fetch that posts what it wants, and take for the answers */
export function asking(post: (ask: Ask) => void): { fetch: Fetch; take(answer: Fetched): void } {
	const waiting = new Map<number, (answer: Fetched) => void>();
	let last = 0;
	const fetch: Fetch = (url, range, signal) =>
		new Promise((resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			const id = ++last;
			const abort = () => {
				waiting.delete(id);
				post({ unfetch: id });
				reject(signal!.reason);
			};
			waiting.set(id, (answer) => {
				signal?.removeEventListener('abort', abort);
				if ('bytes' in answer) resolve(answer.bytes);
				else reject(answer.missing ? new Missing(answer.error) : new Error(answer.error));
			});
			signal?.addEventListener('abort', abort, { once: true });
			post({ fetch: id, url, range });
		});
	return {
		fetch,
		take(answer) {
			const settle = waiting.get(answer.fetched);
			waiting.delete(answer.fetched);
			settle?.(answer);
		}
	};
}

/** the main thread's side: answers one worker's asks from fetch */
export function answering(
	fetch: Fetch,
	post: (answer: Fetched, transfer: Transferable[]) => void
): (ask: Ask) => void {
	const running = new Map<number, AbortController>();
	return (ask) => {
		if ('unfetch' in ask) return void running.get(ask.unfetch)?.abort();
		const id = ask.fetch;
		const controller = new AbortController();
		running.set(id, controller);
		void (async () => fetch(ask.url, ask.range, controller.signal))()
			.then(
				(bytes) => {
					// a copy: the page keeps its own array, and a view would take its whole buffer along
					const copy = bytes.slice();
					post({ fetched: id, bytes: copy }, [copy.buffer]);
				},
				(error: unknown) => {
					const text = error instanceof Error ? error.message : String(error);
					post({ fetched: id, error: text, missing: error instanceof Missing }, []);
				}
			)
			.finally(() => running.delete(id));
	};
}
