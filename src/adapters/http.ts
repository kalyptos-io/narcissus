import { Missing, type Fetch } from '../ports.ts';

/** a Fetch over http(s) with single closed ranges; a server that ignores the range is sliced */
export const http: Fetch = async (url, range, signal) => {
	const response = await fetch(
		url,
		range ? { signal, headers: { Range: `bytes=${range[0]}-${range[1] - 1}` } } : { signal }
	);
	if (response.status === 404) throw new Missing(`http 404 for ${url}`);
	if (response.status !== 200 && response.status !== 206) {
		throw new Error(`http ${response.status} for ${url}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	return range && response.status === 200 ? bytes.slice(range[0], range[1]) : bytes;
};
