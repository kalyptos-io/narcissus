// stand-in for the attribute streams until they land: every stream reads its default, 0, and every
// record is empty; reads the pass's extension and pages

struct Record {
	at: u32,
	words: u32,
}

fn attribute_word(page: u32, row: u32, stream: u32, component: u32) -> u32 {
	return extension[0u] & 0u;
}

fn attribute_record(page: u32, row: u32, stream: u32) -> Record {
	return Record(0u, 0u);
}

fn record_u32(r: Record, i: u32) -> u32 {
	return select(0u, extension[r.at + i], i < r.words);
}

fn record_f16x2(r: Record, i: u32) -> vec2f {
	return unpack2x16float(record_u32(r, i));
}
