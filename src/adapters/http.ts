import type { Fetch } from '../ports.ts';

export const httpError = (status: number, url: string) => new Error(`http ${status} for ${url}`);

/** a file is not there; told by the message, which is all of an error that leaves a worker */
export const isMissing = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).startsWith('http 404 ');

/** a Fetch over http(s) with single closed ranges; a server that ignores the range is sliced */
export const http: Fetch = async (url, range, signal) => {
	const response = await fetch(
		url,
		range ? { signal, headers: { Range: `bytes=${range[0]}-${range[1] - 1}` } } : { signal }
	);
	if (response.status !== 200 && response.status !== 206) throw httpError(response.status, url);
	const bytes = new Uint8Array(await response.arrayBuffer());
	return range && response.status === 200 ? bytes.slice(range[0], range[1]) : bytes;
};
