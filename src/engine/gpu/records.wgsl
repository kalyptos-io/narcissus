// a records stream's record: a run of extension words, as attribute_record gives it in the shade and
// a shade passes it to its sample hook through data; reads only the pass's extension, so every pass
// runs it

struct Record {
	at: u32,
	words: u32,
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
