// sorted splats as screen quads, premultiplied over what lies behind them

// word offsets of the sorted keys and values in the sort buffer
struct Sorted {
	keys: u32,
	values: u32,
}

struct Corner {
	@builtin(position) position: vec4f,
	// offset from the centre in sigmas
	@location(0) uv: vec2f,
	@location(1) colour: vec4f,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> projected: array<Projected>;
@group(0) @binding(2) var<storage, read> sort: array<u32>;
@group(0) @binding(3) var<uniform> sorted: Sorted;

fn corner(v: u32, i: u32) -> Corner {
	let p = projected[sort[sorted.values + i]];
	let major = unpack2x16float(p.axes.x);
	let minor = unpack2x16float(p.axes.y);
	let colour = vec4f(unpack2x16float(p.colour.x), unpack2x16float(p.colour.y));
	// out to where the gaussian falls under 1/255, at most 3 sigmas
	let r = min(3.0, sqrt(max(2.0 * log(255.0 * colour.a), 0.0)));
	let uv = vec2f(f32(v & 1u), f32(v >> 1u)) * 2.0 - 1.0;
	let pixel = p.centre + (major * uv.x + minor * uv.y) * r;
	return Corner(vec4f(pixel / frame.viewport * 2.0 - 1.0, 0.0, 1.0), uv * r, colour);
}

fn alpha(uv: vec2f, opacity: f32) -> f32 {
	return opacity * exp(-0.5 * dot(uv, uv));
}

@vertex
fn vsColour(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Corner {
	return corner(v, i);
}

@vertex
fn vsDepth(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Corner {
	var c = corner(v, i);
	// inverse of the key: the span from near to far in log depth
	c.position.z = 1.0 - f32(sort[sorted.keys + i]) / f32((1u << KEY_BITS) - 1u);
	return c;
}

@fragment
fn fs(c: Corner) -> @location(0) vec4f {
	let a = alpha(c.uv, c.colour.a);
	if (a < 1.0 / 255.0) {
		discard;
	}
	return vec4f(c.colour.rgb * a, a);
}
