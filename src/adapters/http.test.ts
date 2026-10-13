import { afterEach, describe, expect, it, vi } from 'vitest';
import { Missing } from '../ports.ts';
import { http } from './http.ts';

const file = new Uint8Array(Array.from({ length: 32 }, (_, k) => k));

/** a server over file that answers ranges with 206, or ignores them when told to */
function serve(ignoreRanges = false, status?: number) {
	const calls: { url: string; range: string | null; signal: AbortSignal | null | undefined }[] = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		const range = new Headers(init?.headers).get('range');
		calls.push({ url, range, signal: init?.signal });
		if (status) return new Response(null, { status });
		const match = range && !ignoreRanges ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
		if (!match) return new Response(file, { status: 200 });
		const body = file.slice(Number(match[1]), Number(match[2]) + 1);
		return new Response(body, { status: 206 });
	});
	vi.stubGlobal('fetch', fetch);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('http', () => {
	it('asks for a closed range and returns the 206 body', async () => {
		const calls = serve();
		expect([...(await http('https://w/a.pack', [4, 8]))]).toEqual([4, 5, 6, 7]);
		expect(calls).toMatchObject([{ url: 'https://w/a.pack', range: 'bytes=4-7' }]);
	});

	it('slices a 200 from a server that ignores the range', async () => {
		serve(true);
		expect([...(await http('https://w/a.pack', [30, 32]))]).toEqual([30, 31]);
	});

	it('fetches the whole file without a range header for a null range', async () => {
		const calls = serve();
		expect(await http('https://w/a.idx', null)).toEqual(file);
		expect(calls[0].range).toBeNull();
	});

	it('passes the signal through', async () => {
		const calls = serve();
		const signal = new AbortController().signal;
		await http('https://w/a.pack', [0, 1], signal);
		expect(calls[0].signal).toBe(signal);
	});

	it('throws Missing for a 404', async () => {
		serve(false, 404);
		await expect(http('https://w/gone.pack', [0, 1])).rejects.toBeInstanceOf(Missing);
	});

	it('throws an error naming the status and url for any other status', async () => {
		serve(false, 503);
		const url = 'https://w/down.pack';
		const error = await http(url, [0, 1]).catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(Missing);
		expect((error as Error).message).toMatch(/503.*w\/down\.pack/);
	});
});
