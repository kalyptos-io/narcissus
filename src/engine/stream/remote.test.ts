import { describe, expect, it, vi } from 'vitest';
import { Missing, type Fetch } from '../../ports.ts';
import { answering, asking } from './remote.ts';

/** both sides joined as a worker and its page are, each message delivered in a later task */
function join(source: Fetch) {
	const later = (fn: () => void) => void setTimeout(fn, 0);
	const worker = asking((ask) => later(() => answer(structuredClone(ask))));
	const answer = answering(source, (fetched, transfer) =>
		later(() => worker.take(structuredClone(fetched, { transfer })))
	);
	return worker.fetch;
}

describe('remote', () => {
	it('fetches a range through the page and leaves the page its array', async () => {
		const held = new Uint8Array([1, 2, 3, 4]);
		const source = vi.fn<Fetch>(async () => held.subarray(1, 3));
		expect([...(await join(source)('u/a.pack', [1, 3]))]).toEqual([2, 3]);
		expect(source.mock.calls[0].slice(0, 2)).toEqual(['u/a.pack', [1, 3]]);
		expect([...held]).toEqual([1, 2, 3, 4]);
	});

	it('keeps a missing file a Missing and any other failure an Error with its message', async () => {
		const missing = join(async () => {
			throw new Missing('no file u/a.idx');
		});
		await expect(missing('u/a.idx', null)).rejects.toBeInstanceOf(Missing);
		const failing = join(() => {
			throw new Error('denied');
		});
		const error = await failing('u/a.idx', null).catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(Missing);
		expect((error as Error).message).toBe('denied');
	});

	it('aborts the fetch of the page when the worker aborts its own', async () => {
		let aborted = false;
		const source: Fetch = (_url, _range, signal) =>
			new Promise((_resolve, reject) => {
				signal!.addEventListener('abort', () => {
					aborted = true;
					reject(signal!.reason);
				});
			});
		const controller = new AbortController();
		const fetching = join(source)('u/a.pack', [0, 8], controller.signal);
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		await expect(fetching).rejects.toMatchObject({ name: 'AbortError' });
		await new Promise((r) => setTimeout(r, 5));
		expect(aborted).toBe(true);
	});
});
