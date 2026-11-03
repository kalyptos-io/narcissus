import { describe, expect, it } from 'vitest';
import type { Attribute } from './types.ts';
import { atrTrailer, chunkWords, parseAtr, readRecords, readValues } from './atr.ts';
import { encodeAtr, encodeChunk } from './encode.ts';
import { inflate } from './inflate.ts';
import { ATTRIBUTE_TYPES, DESCRIPTOR, ENCODING } from './spec.ts';

const { plain, dictionary, sparse } = ENCODING;

const fixed = (type: Attribute['type'], components: number, value = 0): Attribute => ({
	type,
	components,
	default: Array(components).fill(value),
	rule: 'preserved'
});
const RECORDS: Attribute = { type: 'records', components: 0, default: [], rule: 'preserved' };

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('encodeChunk and readValues', () => {
	const cases: [Attribute, number[]][] = [
		[fixed('u8', 1), [0, 255, 7, 7, 0]],
		[fixed('u16', 2, 9), [1, 2, 9, 9, 65535, 0]],
		[fixed('i16', 1, -1), [-32768, -1, 32767, -1]],
		[fixed('i32', 3), [-5, 6, -7, 0, 0, 0, 2147483647, -2147483648, 1]],
		[fixed('u32', 1), [4294967295, 0, 0, 12]],
		[fixed('f16', 2, 0.5), [0.5, 0.5, -1.25, 2048, 0.5, 0.5, 0.0625, 3]],
		[fixed('f32', 4), [0.1, -2.5, 3e30, 0, 0, 0, 0, 0]]
	];

	it('reads back every value in every encoding', () => {
		for (const [a, values] of cases) {
			const rows = values.length / a.components;
			for (const encoding of [plain, dictionary, sparse]) {
				const body = encodeChunk(values, a, encoding);
				const read = readValues(body, { encoding, rows }, a);
				const want = a.type === 'f32' ? values.map(Math.fround) : values;
				expect(Array.from(read), `${a.type} in ${encoding}`).toEqual(want);
			}
		}
	});

	it('lists in a sparse chunk only the rows that are not the default', () => {
		const a = fixed('u16', 2, 9);
		const body = encodeChunk([9, 9, 1, 9, 9, 9, 9, 2], a, sparse);
		const v = new DataView(body.buffer);
		expect([v.getUint32(0, true), v.getUint32(4, true), v.getUint32(8, true)]).toEqual([2, 1, 3]);
		expect(body.length).toBe(4 + 2 * 4 + 2 * 4);
	});

	it('indexes a dictionary of 256 by u8 and of 257 to 65536 by u16, and refuses more', () => {
		const a = fixed('u32', 1);
		for (const [k, index] of [
			[256, 1],
			[257, 2],
			[65536, 2]
		]) {
			const values = Array.from({ length: k }, (_, v) => v * 3);
			const body = encodeChunk(values, a, dictionary);
			expect(body.length).toBe(4 + 4 * k + index * k);
			expect(Array.from(readValues(body, { encoding: dictionary, rows: k }, a))).toEqual(values);
		}
		const over = Array.from({ length: 65537 }, (_, v) => v);
		expect(() => encodeChunk(over, a, dictionary)).toThrow('overflow a dictionary');
	});

	it('rejects bodies whose sizes, rows or indices do not fit', () => {
		const a = fixed('u16', 1);
		const plainBody = encodeChunk([1, 2, 3], a, plain);
		expect(() => readValues(plainBody, { encoding: plain, rows: 4 }, a)).toThrow(
			'holds 6 bytes, its counts need 8'
		);
		const dict = encodeChunk([1, 2, 1], a, dictionary);
		dict[dict.length - 1] = 2;
		expect(() => readValues(dict, { encoding: dictionary, rows: 3 }, a)).toThrow(
			'indexes entry 2 of a dictionary of 2'
		);
		const listed = encodeChunk([0, 5, 0, 6], a, sparse);
		new DataView(listed.buffer).setUint32(8, 1, true);
		expect(() => readValues(listed, { encoding: sparse, rows: 4 }, a)).toThrow('out of order');
		expect(() =>
			readValues(encodeChunk([0, 5], a, sparse), { encoding: sparse, rows: 1 }, a)
		).toThrow('out of order or past the page');
		expect(() => readValues(plainBody, { encoding: 3, rows: 3 }, a)).toThrow('in encoding 3');
	});
});

describe('encodeChunk and readRecords', () => {
	const records = [bytes(1, 2, 3), bytes(), bytes(4, 5, 6, 7, 8), bytes(), bytes(9)];

	it('reads back every record, plain or sparse', () => {
		for (const encoding of [plain, sparse]) {
			const body = encodeChunk(records, RECORDS, encoding);
			expect(readRecords(body, { encoding, rows: 5 }, RECORDS)).toEqual(records);
		}
		expect(encodeChunk(records, RECORDS, sparse).length).toBe(4 + 3 * 4 + 4 * 4 + 9);
	});

	it('has no dictionary, and rejects offsets that go back', () => {
		expect(() => encodeChunk(records, RECORDS, dictionary)).toThrow('no dictionary');
		const body = encodeChunk(records, RECORDS, plain);
		new DataView(body.buffer).setUint32(4, 4, true);
		expect(() => readRecords(body, { encoding: plain, rows: 5 }, RECORDS)).toThrow('go back');
	});
});

describe('chunkWords', () => {
	const descriptor = (encoding: number, a: Attribute, count: number) =>
		(encoding |
			(ATTRIBUTE_TYPES[a.type] << DESCRIPTOR.type) |
			(a.components << DESCRIPTOR.components) |
			(count << DESCRIPTOR.count)) >>>
		0;

	it('lays plain values out from word 0', () => {
		const a = fixed('u8', 1);
		const { descriptor: d, words } = chunkWords(
			encodeChunk([1, 2, 3, 4, 5], a, plain),
			{ encoding: plain, rows: 5 },
			a
		);
		expect(d).toBe(descriptor(plain, a, 0));
		expect(Array.from(words)).toEqual([0x04030201, 0x05]);
	});

	it('starts a dictionary at word 0 and its indices at the next whole word', () => {
		const a = fixed('u16', 1);
		const { descriptor: d, words } = chunkWords(
			encodeChunk([7, 8, 9, 7, 7], a, dictionary),
			{ encoding: dictionary, rows: 5 },
			a
		);
		expect(d).toBe(descriptor(dictionary, a, 3));
		expect(Array.from(words)).toEqual([0x00080007, 0x9, 0x00020100, 0x0]);
	});

	it('puts the sparse rows first, then their values', () => {
		const a = fixed('i8', 2);
		const { descriptor: d, words } = chunkWords(
			encodeChunk([0, 0, -1, 2, 0, 0, 3, -4], a, sparse),
			{ encoding: sparse, rows: 4 },
			a
		);
		expect(d).toBe(descriptor(sparse, a, 2));
		expect(Array.from(words)).toEqual([1, 3, 0xfc0302ff]);
	});

	it('pads each record to whole words behind word offsets', () => {
		const records = [bytes(1, 2, 3, 4, 5), bytes(), bytes(6)];
		const plainWords = chunkWords(
			encodeChunk(records, RECORDS, plain),
			{ encoding: plain, rows: 3 },
			RECORDS
		);
		expect(plainWords.descriptor).toBe(descriptor(plain, RECORDS, 3));
		expect(Array.from(plainWords.words)).toEqual([0, 2, 2, 3, 0x04030201, 0x05, 0x06]);
		const sparseWords = chunkWords(
			encodeChunk(records, RECORDS, sparse),
			{ encoding: sparse, rows: 3 },
			RECORDS
		);
		expect(sparseWords.descriptor).toBe(descriptor(sparse, RECORDS, 2));
		expect(Array.from(sparseWords.words)).toEqual([0, 2, 0, 2, 3, 0x04030201, 0x05, 0x06]);
	});
});

describe('encodeAtr and parseAtr', () => {
	const a = fixed('u16', 1);
	const chunks = [
		{ stream: 1, encoding: plain, offset: 900, rows: 2, body: encodeChunk([1, 2], a, plain) },
		{ stream: 0, encoding: sparse, offset: 900, rows: 2, body: encodeChunk([0, 3], a, sparse) },
		{ stream: 0, encoding: plain, offset: 40, rows: 3, body: encodeChunk([4, 5, 6], a, plain) }
	];
	const pack = '0123456789abcdef';
	const file = () => encodeAtr(pack, ['test.b', 'tëst.ä'], chunks);

	it('orders chunks by blob offset, then stream, and reads each back by its place', async () => {
		const bytes = await file();
		for (const tail of [bytes, bytes.subarray(10)]) {
			const atr = parseAtr(tail, bytes.length);
			expect(atr.pack).toBe(pack);
			expect(atr.streams).toEqual(['test.b', 'tëst.ä']);
			expect(atr.chunks.map(({ stream, offset }) => [offset, stream])).toEqual([
				[40, 0],
				[900, 0],
				[900, 1]
			]);
			const ordered = [chunks[2], chunks[1], chunks[0]];
			for (const [c, chunk] of atr.chunks.entries()) {
				expect(chunk).toMatchObject({ encoding: ordered[c].encoding, rows: ordered[c].rows });
				const body = await inflate(bytes.subarray(chunk.at, chunk.at + chunk.length));
				expect(body).toEqual(ordered[c].body);
			}
		}
	});

	it('gives the tables offset from the trailer alone', async () => {
		const bytes = await file();
		const { tables, chunks: count } = atrTrailer(bytes.subarray(bytes.length - 24), bytes.length);
		expect(count).toBe(3);
		expect(parseAtr(bytes.subarray(tables), bytes.length).chunks).toHaveLength(3);
		expect(() => parseAtr(bytes.subarray(tables + 1), bytes.length)).toThrow(
			'before the bytes read'
		);
	});

	it('rejects a broken trailer or tables', async () => {
		const broken = async (change: (bytes: Uint8Array, view: DataView) => void) => {
			const bytes = await file();
			change(bytes, new DataView(bytes.buffer));
			return () => parseAtr(bytes, bytes.length);
		};
		const end = (await file()).length;
		const table = end - 24 - 3 * 20;
		expect(await broken((b) => (b[end - 8] = 0))).toThrow('does not end in an .atr trailer');
		expect(await broken((_, v) => v.setUint16(end - 4, 2, true))).toThrow('version 2');
		expect(await broken((_, v) => v.setUint32(end - 12, 9, true))).toThrow('do not fit');
		expect(await broken((_, v) => v.setUint16(table, 2, true))).toThrow('stream 2 of 2');
		expect(await broken((b) => (b[table + 2] = 3))).toThrow('in encoding 3');
		expect(await broken((_, v) => v.setUint32(table + 4, 901, true))).toThrow('out of blob offset');
		expect(await broken((_, v) => v.setUint32(table + 16, 9999, true))).toThrow('past its tables');
	});
});
