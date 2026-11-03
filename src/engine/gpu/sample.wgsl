// host tables and sample hooks, shared by project, pick and raster; each declares the uniforms,
// plugins, pages and extension bindings these read

// u32 words of a sample record: coverage b as f16 pairs by column, r g and b opacity as f16 pairs,
// page, row, the hook below coverage low as f16, then the shade's data
const RECORD_WORDS: u32 = 16u;

struct Sample {
	// the pixel's centre less the splat's centre, in pixels, y up
	offset: vec2f,
	// the splat's colour (not premultiplied) and opacity after shade
	colour: vec3f,
	opacity: f32,
	// the splat's gaussian falloff at offset, times opacity: what the raster would draw as alpha
	alpha: f32,
	// what the shade passed to sample_request
	data: array<u32, 8>,
	coverage: Coverage,
	page: u32,
	row: u32,
}

struct Sampled {
	// premultiplied colour and alpha; alpha at most c.alpha
	colour: vec4f,
	token: u32,
}

// word i of host table id, 0 past its end; the directory holds each table's first word and length
fn table(id: u32, i: u32) -> u32 {
	if (id >= uniforms.tableCount) {
		return 0u;
	}
	let entry = uniforms.tables + 2u * id;
	return select(0u, extension[extension[entry] + i], i < extension[entry + 1u]);
}

// the shade hook running now, as shade() numbers its sample hooks, 0 for others; the first to ask
// and what it passed
var<private> sample_asker: u32;
var<private> sample_hook: u32;
var<private> sample_data: array<u32, 8>;

fn sample_request(s: ptr<function, Splat>, data: array<u32, 8>) {
	if (sample_hook == 0u) {
		sample_hook = sample_asker;
		sample_data = data;
	}
}

// the record of a splat whose shade asked, quantised as the raster reads it
fn sample_record(s: Splat, c: Coverage) -> array<u32, RECORD_WORDS> {
	var r: array<u32, RECORD_WORDS>;
	r[0] = pack2x16float(c.b[0]);
	r[1] = pack2x16float(c.b[1]);
	r[2] = pack2x16float(c.b[2]);
	r[3] = pack2x16float(s.colour.rg);
	r[4] = pack2x16float(vec2f(s.colour.b, s.opacity));
	r[5] = s.page;
	r[6] = s.row;
	r[7] = (pack2x16float(vec2f(0.0, c.low)) & 0xffff0000u) | sample_hook;
	for (var k = 0u; k < 8u; k++) {
		r[8u + k] = sample_data[k];
	}
	return r;
}

// the sample a record gives a pixel at offset where the splat's falloff draws alpha
fn sample_of(r: array<u32, RECORD_WORDS>, offset: vec2f, alpha: f32) -> Sample {
	var c: Sample;
	c.offset = offset;
	let ba = unpack2x16float(r[4]);
	c.colour = vec3f(unpack2x16float(r[3]), ba.x);
	c.opacity = ba.y;
	c.alpha = alpha;
	for (var k = 0u; k < 8u; k++) {
		c.data[k] = r[8u + k];
	}
	let b = mat3x2f(unpack2x16float(r[0]), unpack2x16float(r[1]), unpack2x16float(r[2]));
	c.coverage = Coverage(b, unpack2x16float(r[7]).y);
	c.page = r[5];
	c.row = r[6];
	return c;
}
