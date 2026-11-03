// sorted splats as screen quads, premultiplied over what lies behind them; the Sampled entry points,
// used while a sample hook or a clip is installed, draw a tagged splat through its hook and its clip

// word offsets of the sorted keys and values in the sort buffer
struct Sorted {
	keys: u32,
	values: u32,
}

// a sampled splat's record, else NONE
const NONE: u32 = 0xffffffffu;

struct Corner {
	@builtin(position) position: vec4f,
	// offset from the centre in sigmas
	@location(0) uv: vec2f,
	@location(1) colour: vec4f,
}

struct SampledCorner {
	@builtin(position) position: vec4f,
	@location(0) uv: vec2f,
	@location(1) colour: vec4f,
	// from the centre in pixels, y up
	@location(2) offset: vec2f,
	@location(3) @interpolate(flat) record: u32,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var<storage, read> projected: array<Projected>;
@group(0) @binding(2) var<storage, read> sort: array<u32>;
@group(0) @binding(3) var<uniform> sorted: Sorted;
@group(0) @binding(4) var<uniform> plugins: array<vec4f, 16>;
@group(0) @binding(5) var<storage, read> extension: array<u32>;
@group(0) @binding(6) var<storage, read_write> over: atomic<u32>;

fn coverage_over() {
	atomicAdd(&over, 1u);
}

fn corner(v: u32, i: u32) -> SampledCorner {
	let p = projected[sort[sorted.values + i]];
	let major = unpack2x16float(p.axes.x);
	let minor = unpack2x16float(p.axes.y);
	let ba = unpack2x16float(p.colour.y);
	let sampled = ba.y < 0.0;
	let colour = vec4f(unpack2x16float(p.colour.x), ba.x, abs(ba.y));
	let r = reach(colour.a);
	let uv = vec2f(f32(v & 1u), f32(v >> 1u)) * 2.0 - 1.0;
	let offset = (major * uv.x + minor * uv.y) * r;
	let pixel = p.centre + offset;
	let clip = vec4f(pixel / uniforms.viewport * 2.0 - 1.0, 0.0, 1.0);
	return SampledCorner(clip, uv * r, colour, offset, select(NONE, p.colour.x, sampled));
}

// inverse of the key: the span from near to far in log depth
fn depth(i: u32) -> f32 {
	return 1.0 - f32(sort[sorted.keys + i]) / f32((1u << KEY_BITS) - 1u);
}

fn alpha(uv: vec2f, opacity: f32) -> f32 {
	return opacity * exp(-0.5 * dot(uv, uv));
}

@vertex
fn vsColour(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Corner {
	let c = corner(v, i);
	return Corner(c.position, c.uv, c.colour);
}

@vertex
fn vsDepth(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Corner {
	var c = corner(v, i);
	c.position.z = depth(i);
	return Corner(c.position, c.uv, c.colour);
}

@fragment
fn fs(c: Corner) -> @location(0) vec4f {
	let a = alpha(c.uv, c.colour.a);
	if (a < 1.0 / 255.0) {
		discard;
	}
	return vec4f(c.colour.rgb * a, a);
}

@vertex
fn vsSampledColour(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> SampledCorner {
	return corner(v, i);
}

@vertex
fn vsSampledDepth(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> SampledCorner {
	var c = corner(v, i);
	c.position.z = depth(i);
	return c;
}

@fragment
fn fsSampled(c: SampledCorner) -> @location(0) vec4f {
	let a = alpha(c.uv, c.colour.a);
	if (a < 1.0 / 255.0) {
		discard;
	}
	if (c.record == NONE) {
		return vec4f(c.colour.rgb * a, a);
	}
	var r: array<u32, RECORD_WORDS>;
	let at = uniforms.records + c.record * RECORD_WORDS;
	for (var k = 0u; k < RECORD_WORDS; k++) {
		r[k] = extension[at + k];
	}
	let out = sample_dispatch(r[7] & 0xffffu, sample_of(r, c.offset, a));
	if (out.colour.a < 1.0 / 255.0) {
		discard;
	}
	return out.colour;
}
