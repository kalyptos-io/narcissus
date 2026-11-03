// stand-in for a records stream's reader until attribute streams land: a run of extension words,
// as attribute_record gives it in the shade and a shade passes it to its sample hook through data

struct Record {
	at: u32,
	words: u32,
}

fn record_u32(r: Record, i: u32) -> u32 {
	return select(0u, extension[r.at + i], i < r.words);
}

fn record_f16x2(r: Record, i: u32) -> vec2f {
	return unpack2x16float(record_u32(r, i));
}
