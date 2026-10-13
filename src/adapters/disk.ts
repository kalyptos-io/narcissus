import { open } from 'node:fs/promises';
import { Missing, type Fetch } from '../ports.ts';

/** a Fetch over the file system, for node; a url is a path */
export const disk: Fetch = async (url, range) => {
	const file = await open(url).catch((error: NodeJS.ErrnoException) => {
		throw error.code === 'ENOENT' ? new Missing(`no file ${url}`) : error;
	});
	try {
		if (!range) return new Uint8Array(await file.readFile());
		const bytes = new Uint8Array(range[1] - range[0]);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, range[0]);
		return bytes.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
};
