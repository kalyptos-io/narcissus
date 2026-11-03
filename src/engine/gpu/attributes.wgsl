// the attribute streams of resident pages, from the extension buffer; the pass declares
// extension: array<u32> and pages: array<Page>. a page's directory is its stream count, then two
// words a stream: the word offset of its values and its descriptor; layouts in format/spec.ts

// extension words 4 s to 4 s + 3 hold stream s's default, widened as attribute_word gives it, for
// the ATTRIBUTE_STREAMS of layout.ts
const ATTRIBUTE_RECORDS: u32 = 9u;
const ENCODING_DICTIONARY: u32 = 1u;
const ENCODING_SPARSE: u32 = 2u;

struct Record {
	at: u32,
	words: u32,
}

// the values' word offset and the descriptor of stream on page, zero when the page has none
fn attribute_entry(page: u32, stream: u32) -> vec2u {
	let directory = pages[page].attributes;
	if (directory == ATTRIBUTE_NONE || stream >= extension[directory]) {
		return vec2u(0u);
	}
	let at = directory + 1u + 2u * stream;
	return vec2u(extension[at], extension[at + 1u]);
}

// bytes of a scalar of type kind
fn attribute_bytes(kind: u32) -> u32 {
	switch kind {
		case 1u, 4u: {
			return 1u;
		}
		case 2u, 5u, 7u: {
			return 2u;
		}
		default: {
			return 4u;
		}
	}
}

// scalar index of those of type kind from word at, widened to 32 bits
fn attribute_scalar(at: u32, index: u32, kind: u32) -> u32 {
	let size = attribute_bytes(kind);
	let byte = index * size;
	let word = extension[at + byte / 4u];
	let bit = (byte % 4u) * 8u;
	switch kind {
		case 4u, 5u: {
			return bitcast<u32>(extractBits(bitcast<i32>(word), bit, size * 8u));
		}
		case 7u: {
			return bitcast<u32>(unpack2x16float(extractBits(word, bit, 16u)).x);
		}
		default: {
			return extractBits(word, bit, size * 8u);
		}
	}
}

// the place of row among the m increasing rows from word at, m when it is not there
fn attribute_find(at: u32, m: u32, row: u32) -> u32 {
	var lo = 0u;
	var hi = m;
	while (lo < hi) {
		let mid = (lo + hi) / 2u;
		if (extension[at + mid] < row) {
			lo = mid + 1u;
		} else {
			hi = mid;
		}
	}
	if (lo < m && extension[at + lo] == row) {
		return lo;
	}
	return m;
}

// component of row's value of a fixed stream on page, widened to 32 bits; the default without one
fn attribute_word(page: u32, row: u32, stream: u32, component: u32) -> u32 {
	let entry = attribute_entry(page, stream);
	let kind = extractBits(entry.y, 2u, 4u);
	let absent = extension[4u * stream + component];
	if (kind == 0u || kind == ATTRIBUTE_RECORDS) {
		return absent;
	}
	let components = extractBits(entry.y, 6u, 3u);
	let count = entry.y >> 9u;
	switch extractBits(entry.y, 0u, 2u) {
		case ENCODING_DICTIONARY: {
			let indices = entry.x + (count * components * attribute_bytes(kind) + 3u) / 4u;
			let index = attribute_scalar(indices, row, select(1u, 2u, count > 256u));
			return attribute_scalar(entry.x, index * components + component, kind);
		}
		case ENCODING_SPARSE: {
			let k = attribute_find(entry.x, count, row);
			if (k == count) {
				return absent;
			}
			return attribute_scalar(entry.x + count, k * components + component, kind);
		}
		default: {
			return attribute_scalar(entry.x, row * components + component, kind);
		}
	}
}

// row's record of a records stream on page, empty without one
fn attribute_record(page: u32, row: u32, stream: u32) -> Record {
	let entry = attribute_entry(page, stream);
	let count = entry.y >> 9u;
	if (extractBits(entry.y, 2u, 4u) != ATTRIBUTE_RECORDS) {
		return Record(0u, 0u);
	}
	var k = row;
	var offsets = entry.x;
	if (extractBits(entry.y, 0u, 2u) == ENCODING_SPARSE) {
		k = attribute_find(entry.x, count, row);
		offsets = entry.x + count;
	}
	if (k >= count) {
		return Record(0u, 0u);
	}
	let start = extension[offsets + k];
	return Record(offsets + count + 1u + start, extension[offsets + k + 1u] - start);
}

// word i of a record, 0 past its end
fn record_u32(r: Record, i: u32) -> u32 {
	if (i >= r.words) {
		return 0u;
	}
	return extension[r.at + i];
}

fn record_f16x2(r: Record, i: u32) -> vec2f {
	return unpack2x16float(record_u32(r, i));
}
