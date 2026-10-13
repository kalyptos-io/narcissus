import { Missing, type Fetch } from '../ports.ts';

/** a Fetch over files in memory, as a dropped folder holds them; a url is a file's path in entries */
export function files(entries: ReadonlyMap<string, Blob>): Fetch {
	return async (url, range) => {
		const file = entries.get(url);
		if (!file) throw new Missing(`no file ${url}`);
		const part = range ? file.slice(range[0], range[1]) : file;
		return new Uint8Array(await part.arrayBuffer());
	};
}
