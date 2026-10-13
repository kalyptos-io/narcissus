// far-field depth of field: each pixel gathers a disc as wide as its blur, from taps whose own blur reaches it

struct Dof {
	focus: f32,
	range: f32,
	near: f32,
	// ln(far / near)
	span: f32,
	// pixels at full blur
	radius: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<uniform> dof: Dof;

const TAPS = 32u;
const GOLDEN = 2.39996323;

// blur radius in pixels: none up to the focus, full a range past it
fn blur(p: vec2i) -> f32 {
	let z = dof.near * exp(textureLoad(depth, p, 0) * dof.span);
	return clamp((z - dof.focus) / dof.range, 0.0, 1.0) * dof.radius;
}

@fragment
fn fs(@builtin(position) coord: vec4f) -> @location(0) vec4f {
	let p = vec2i(coord.xy);
	let r = blur(p);
	var sum = textureLoad(scene, p, 0).rgb;
	if (r < 0.5) {
		return vec4f(sum, 1.0);
	}
	let last = vec2i(textureDimensions(scene)) - 1;
	var weight = 1.0;
	// golden-angle spiral, even over the disc
	for (var k = 0u; k < TAPS; k++) {
		let rho = sqrt((f32(k) + 0.5) / f32(TAPS)) * r;
		let angle = f32(k) * GOLDEN;
		let q = clamp(p + vec2i(round(rho * vec2f(cos(angle), sin(angle)))), vec2i(0), last);
		// a sharper tap keeps its colour, so focused edges don't bleed into the blur
		let w = clamp(blur(q) - rho + 1.0, 0.0, 1.0);
		sum += textureLoad(scene, q, 0).rgb * w;
		weight += w;
	}
	return vec4f(sum / weight, 1.0);
}
