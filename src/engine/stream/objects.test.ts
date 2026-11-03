import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecodedPage, PageRow } from '../../format/index.ts';
import { encodeIds } from '../../format/encode.ts';
import type { Fetch } from '../../ports.ts';
import { Objects } from './objects.ts';

const PACK = 'u/0/724000/6177000.0123456789abcdef.pack';
const IDS = 'https://host/ids/6177000.ids';

/** a page of count splats at blob offset */
function row(offset: number, count: number): PageRow {
	const quadrants: [number, number, number] = [count, count, count];
	return { g: 0, i: 0, j: 0, count, quadrants, box: new Float32Array(6), offset, length: 10 };
}

/** a decoded page whose word 3 holds scale bits, as decodePage writes them */
function page(count: number): DecodedPage {
	const geometry = new Uint32Array(count * 4);
	for (let t = 0; t < count; t++) geometry[t * 4 + 3] = 0x1234;
	const empty = {
		colour: new Uint32Array(0),
		params: new Float32Array(0),
		clusters: new Float32Array(0)
	};
	return { count, quadrants: [count, count, count], geometry, ...empty };
}

/** objects over one .ids at IDS for PACK, and a promise of its first load */
async function serve(ids: number[]) {
	const bytes = await encodeIds(Uint16Array.from(ids));
	const fetch = vi.fn<Fetch>(async () => bytes.slice());
	let settle!: () => void;
	const loaded = new Promise<void>((resolve) => (settle = resolve));
	return { objects: new Objects({ [PACK]: IDS }, fetch, () => settle()), fetch, loaded };
}

// listed out of blob order: the ids follow the blobs
const ROWS = [row(100, 2), row(0, 3)];

describe('Objects', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('holds a pack until its .ids loads, then writes each page its ids in bits 16-31 of word 3', async () => {
		const { objects, loaded } = await serve([1, 2, 3, 65535, 9]);
		expect(objects.ready(PACK, ROWS)).toBe(false);
		await loaded;
		expect(objects.ready(PACK, ROWS)).toBe(true);
		const first = page(3);
		const second = page(2);
		objects.write(PACK, 0, first);
		objects.write(PACK, 100, second);
		const words = (p: DecodedPage) =>
			Array.from({ length: p.count }, (_, t) => p.geometry[t * 4 + 3]);
		expect(words(first)).toEqual([0x00011234, 0x00021234, 0x00031234]);
		expect(words(second)).toEqual([0xffff1234, 0x00091234]);
	});

	it('ignores an .ids that holds another count of splats, with one warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { objects, loaded } = await serve([1, 2, 3, 4]);
		objects.ready(PACK, ROWS);
		await loaded;
		expect(objects.ready(PACK, ROWS)).toBe(true);
		const ignored = page(3);
		objects.write(PACK, 0, ignored);
		expect(ignored).toEqual(page(3));
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(`${IDS} is ignored: it holds 4 ids for 5 splats`);
	});

	it('lets the pages of a pack it has no .ids for load at once', async () => {
		const { objects, fetch } = await serve([]);
		expect(objects.ready('u/0/0/0.fedcba9876543210.pack', ROWS)).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});
});
