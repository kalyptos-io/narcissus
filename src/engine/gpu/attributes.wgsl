// stand-in for the attribute streams until they land: every stream reads its default, 0, and every
// record is empty; reads the pass's extension and pages, so only shade hooks run it

fn attribute_word(page: u32, row: u32, stream: u32, component: u32) -> u32 {
	return pages[page].count & extension[0u] & 0u;
}

fn attribute_record(page: u32, row: u32, stream: u32) -> Record {
	return Record(0u, 0u);
}
