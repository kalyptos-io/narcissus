// a unit's attribute streams: the .atr's tables and trailer, and its chunks read or laid out for the gpu

import { hashAt } from './idx.ts';
import type { Atr, AtrChunk, Attribute, Scalar } from './types.ts';
import {
	ATR_CHUNK_BYTES,
	ATR_MAGIC,
	ATR_TRAILER,
	ATTRIBUTE_TYPES,
	DESCRIPTOR,
	DESCRIPTOR_COUNT_MAX,
	DICTIONARY_MAX,
	DICTIONARY_U8,
	ENCODING,
	SCALAR_BYTES,
	VERSION
} from './spec.ts';

type Chunk = Pick<AtrChunk, 'encoding' | 'rows'>;

/** byte offsets into a chunk's inflated body, its sizes checked */
interface Layout {
	/** the dictionary's entries or the sparse rows; 0 for plain */
	count: number;
	/** the first value, of the dictionary when there is one */
	values: number;
	/** dictionary: the first row index */
	indices: number;
	/** sparse: the first listed row */
	listed: number;
	/** records: the first offset, and the first byte after the offsets */
	offsets: number;
	bytes: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * the pack hash, the tables' byte offset and the chunk count from the last ATR_TRAILER bytes of an
 * .atr of size bytes; throws naming the fault
 */
export function atrTrailer(
	trailer: Uint8Array,
	size: number
): { pack: string; tables: number; chunks: number } {
	if (trailer.length !== ATR_TRAILER || size < ATR_TRAILER) {
		throw new Error('is shorter than an .atr trailer');
	}
	const v = view(trailer);
	if (String.fromCharCode(...trailer.subarray(16, 20)) !== ATR_MAGIC) {
		throw new Error('does not end in an .atr trailer');
	}
	const version = v.getUint16(20, true);
	if (version !== VERSION)
		throw new Error(`is .atr version ${version}; narcissus reads ${VERSION}`);
	const tables = v.getUint32(8, true);
	const chunks = v.getUint32(12, true);
	if (tables + 4 + chunks * ATR_CHUNK_BYTES > size - ATR_TRAILER) {
		throw new Error('has tables that do not fit before its trailer');
	}
	return { pack: hashAt(v, 0), tables, chunks };
}

/** the tables of an .atr of size bytes from tail, its last bytes from its tables on; throws naming the fault */
export function parseAtr(tail: Uint8Array, size: number): Atr {
	if (tail.length > size) throw new Error(`gives ${tail.length} bytes of a ${size}-byte .atr`);
	const {
		pack,
		tables,
		chunks: count
	} = atrTrailer(tail.subarray(tail.length - ATR_TRAILER), size);
	const start = size - tail.length;
	if (tables < start)
		throw new Error(`has tables from ${tables}, before the bytes read from ${start}`);
	const v = view(tail);
	const end = tail.length - ATR_TRAILER;
	let at = tables - start;
	const cut = () => new Error('has tables that are cut off');
	const streams: string[] = [];
	const s = v.getUint16(at, true);
	at += 4;
	for (let k = 0; k < s; k++) {
		if (at >= end || at + 1 + tail[at] > end) throw cut();
		let name: string;
		try {
			name = utf8.decode(tail.subarray(at + 1, at + 1 + tail[at]));
		} catch {
			throw new Error(`has a stream name that is not utf-8`);
		}
		if (streams.includes(name)) throw new Error(`names stream ${name} twice`);
		streams.push(name);
		at += 1 + tail[at];
	}
	if (end - at !== count * ATR_CHUNK_BYTES) {
		throw new Error(`holds ${end - at} bytes of chunk table for ${count} chunks`);
	}
	const chunks: AtrChunk[] = [];
	for (let c = 0; c < count; c++, at += ATR_CHUNK_BYTES) {
		const chunk: AtrChunk = {
			stream: v.getUint16(at, true),
			encoding: v.getUint8(at + 2),
			offset: v.getUint32(at + 4, true),
			rows: v.getUint32(at + 8, true),
			at: v.getUint32(at + 12, true),
			length: v.getUint32(at + 16, true)
		};
		const where = `chunk ${c}`;
		if (chunk.stream >= s) throw new Error(`has ${where} of stream ${chunk.stream} of ${s}`);
		if (chunk.encoding > ENCODING.sparse) {
			throw new Error(`has ${where} in encoding ${chunk.encoding}`);
		}
		if (chunk.at + chunk.length > tables) throw new Error(`has ${where} past its tables`);
		const last = chunks[c - 1];
		if (
			last &&
			(last.offset > chunk.offset || (last.offset === chunk.offset && last.stream >= chunk.stream))
		) {
			throw new Error(`lists ${where} out of blob offset and stream order`);
		}
		chunks.push(chunk);
	}
	return { pack, streams, chunks };
}

/** a chunk's body checked against its rows and stream; throws naming the fault */
function layout(body: Uint8Array, { encoding, rows }: Chunk, a: Attribute): Layout {
	const v = view(body);
	const at: Layout = { count: 0, values: 0, indices: 0, listed: 0, offsets: 0, bytes: 0 };
	const fit = (size: number) => {
		if (body.length !== size) {
			throw new Error(`holds ${body.length} bytes, its counts need ${size}`);
		}
	};
	const reach = (size: number) => {
		if (body.length < size) throw new Error(`holds ${body.length} bytes, its counts need ${size}`);
	};
	const sparse = () => {
		reach(4);
		const m = v.getUint32(0, true);
		if (m > rows) throw new Error(`lists ${m} rows of ${rows}`);
		reach(4 + 4 * m);
		for (let k = 0, last = -1; k < m; k++) {
			const row = v.getUint32(4 + 4 * k, true);
			if (row <= last || row >= rows)
				throw new Error('lists its rows out of order or past the page');
			last = row;
		}
		at.count = m;
		at.listed = 4;
		return m;
	};

	if (a.type === 'records') {
		let records = rows;
		if (encoding === ENCODING.sparse) records = sparse();
		else if (encoding !== ENCODING.plain)
			throw new Error(`is a records chunk in encoding ${encoding}`);
		at.offsets = encoding === ENCODING.sparse ? 4 + 4 * records : 0;
		at.bytes = at.offsets + 4 * (records + 1);
		reach(at.bytes);
		for (let k = 1; k <= records; k++) {
			if (v.getUint32(at.offsets + 4 * k, true) < v.getUint32(at.offsets + 4 * k - 4, true)) {
				throw new Error('has record offsets that go back');
			}
		}
		fit(at.bytes + v.getUint32(at.offsets + 4 * records, true));
		return at;
	}

	const width = a.components * SCALAR_BYTES[a.type];
	if (encoding === ENCODING.plain) {
		fit(rows * width);
	} else if (encoding === ENCODING.dictionary) {
		reach(4);
		const k = v.getUint32(0, true);
		if (k > DICTIONARY_MAX || (k === 0 && rows > 0)) throw new Error(`has a dictionary of ${k}`);
		const index = k <= DICTIONARY_U8 ? 1 : 2;
		at.count = k;
		at.values = 4;
		at.indices = 4 + k * width;
		fit(at.indices + rows * index);
		for (let row = 0; row < rows; row++) {
			const i = index === 1 ? body[at.indices + row] : v.getUint16(at.indices + 2 * row, true);
			if (i >= k) throw new Error(`indexes entry ${i} of a dictionary of ${k}`);
		}
	} else if (encoding === ENCODING.sparse) {
		const m = sparse();
		at.values = 4 + 4 * m;
		fit(at.values + m * width);
	} else {
		throw new Error(`is in encoding ${encoding}`);
	}
	return at;
}

function scalar(v: DataView, at: number, type: Scalar): number {
	switch (type) {
		case 'u8':
			return v.getUint8(at);
		case 'u16':
			return v.getUint16(at, true);
		case 'u32':
			return v.getUint32(at, true);
		case 'i8':
			return v.getInt8(at);
		case 'i16':
			return v.getInt16(at, true);
		case 'i32':
			return v.getInt32(at, true);
		case 'f16':
			return v.getFloat16(at, true);
		case 'f32':
			return v.getFloat32(at, true);
	}
}

/**
 * the values of a fixed stream's chunk, components per row, for every row: the default where a
 * sparse chunk lists none; throws naming the fault
 */
export function readValues(body: Uint8Array, chunk: Chunk, a: Attribute): Float64Array {
	if (a.type === 'records') throw new Error('is a records stream');
	const at = layout(body, chunk, a);
	const v = view(body);
	const size = SCALAR_BYTES[a.type];
	const width = a.components * size;
	const out = new Float64Array(chunk.rows * a.components);
	const put = (row: number, from: number) => {
		for (let c = 0; c < a.components; c++) {
			out[row * a.components + c] = scalar(v, from + c * size, a.type as Scalar);
		}
	};
	if (chunk.encoding === ENCODING.plain) {
		for (let row = 0; row < chunk.rows; row++) put(row, row * width);
	} else if (chunk.encoding === ENCODING.dictionary) {
		const u8 = at.count <= DICTIONARY_U8;
		for (let row = 0; row < chunk.rows; row++) {
			const i = u8 ? body[at.indices + row] : v.getUint16(at.indices + 2 * row, true);
			put(row, at.values + i * width);
		}
	} else {
		for (let row = 0; row < chunk.rows; row++) out.set(a.default, row * a.components);
		for (let k = 0; k < at.count; k++)
			put(v.getUint32(at.listed + 4 * k, true), at.values + k * width);
	}
	return out;
}

/** the records of a records stream's chunk, one per row, empty where a sparse chunk lists none */
export function readRecords(body: Uint8Array, chunk: Chunk, a: Attribute): Uint8Array[] {
	if (a.type !== 'records') throw new Error(`is a ${a.type} stream`);
	const at = layout(body, chunk, a);
	const v = view(body);
	const out = Array.from({ length: chunk.rows }, () => new Uint8Array(0));
	const listed = chunk.encoding === ENCODING.sparse ? at.count : chunk.rows;
	for (let k = 0; k < listed; k++) {
		const row = chunk.encoding === ENCODING.sparse ? v.getUint32(at.listed + 4 * k, true) : k;
		const from = v.getUint32(at.offsets + 4 * k, true);
		const to = v.getUint32(at.offsets + 4 * k + 4, true);
		out[row] = body.slice(at.bytes + from, at.bytes + to);
	}
	return out;
}

/** a chunk as the gpu reads it, word-aligned; layout in spec.ts; throws naming the fault */
export function chunkWords(
	body: Uint8Array,
	chunk: Chunk,
	a: Attribute
): { descriptor: number; words: Uint32Array<ArrayBuffer> } {
	const at = layout(body, chunk, a);
	const records = a.type === 'records';
	const plain = chunk.encoding === ENCODING.plain;
	const count = plain ? (records ? chunk.rows : 0) : at.count;
	if (count > DESCRIPTOR_COUNT_MAX) throw new Error(`holds ${count} rows, more than the gpu takes`);
	const descriptor =
		((chunk.encoding << DESCRIPTOR.encoding) |
			(ATTRIBUTE_TYPES[a.type] << DESCRIPTOR.type) |
			(a.components << DESCRIPTOR.components) |
			(count << DESCRIPTOR.count)) >>>
		0;
	const words = (n: number) => Math.ceil(n / 4);

	if (!records) {
		// the dictionary or the listed rows, then what follows them, each from a word
		const split = chunk.encoding === ENCODING.dictionary ? at.indices : at.values;
		const head = plain ? 0 : split - 4;
		const out = new Uint32Array(words(head) + words(body.length - split));
		const bytes = new Uint8Array(out.buffer);
		if (!plain) bytes.set(body.subarray(4, 4 + head), 0);
		bytes.set(body.subarray(split), 4 * words(head));
		return { descriptor, words: out };
	}

	const v = view(body);
	const listed = plain ? chunk.rows : at.count;
	const head = (plain ? 0 : listed) + listed + 1;
	const starts = new Uint32Array(listed + 1);
	for (let k = 0; k < listed; k++) {
		const length =
			v.getUint32(at.offsets + 4 * k + 4, true) - v.getUint32(at.offsets + 4 * k, true);
		starts[k + 1] = starts[k] + words(length);
	}
	const out = new Uint32Array(head + starts[listed]);
	const bytes = new Uint8Array(out.buffer);
	if (!plain) bytes.set(body.subarray(at.listed, at.listed + 4 * listed), 0);
	out.set(starts, plain ? 0 : listed);
	for (let k = 0; k < listed; k++) {
		const from = v.getUint32(at.offsets + 4 * k, true);
		const to = v.getUint32(at.offsets + 4 * k + 4, true);
		bytes.set(body.subarray(at.bytes + from, at.bytes + to), 4 * (head + starts[k]));
	}
	return { descriptor, words: out };
}
