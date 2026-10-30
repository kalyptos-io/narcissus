// host graphics over the frame: capsules in screen space from a to b, a marker where a is b

// share of the view depth an occluding fragment may lie behind the splats, so a line on the ground clears their fringe
const SLACK: f32 = 0.02;

struct Capsule {
	@location(0) a: vec3f,
	@location(1) b: vec3f,
	// pixels
	@location(2) radius: f32,
	@location(3) colour: vec4f,
	@location(4) occlude: u32,
}

struct Fragment {
	@builtin(position) position: vec4f,
	// target pixels from the top-left, of the ends
	@location(0) @interpolate(flat) a: vec2f,
	@location(1) @interpolate(flat) b: vec2f,
	// view depth of the ends
	@location(2) @interpolate(flat) depths: vec2f,
	@location(3) @interpolate(flat) radius: f32,
	@location(4) @interpolate(flat) colour: vec4f,
	@location(5) @interpolate(flat) occlude: u32,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var depth: texture_depth_2d;

fn pixel(view: vec3f) -> vec2f {
	let clip = uniforms.proj * vec4f(view, 1.0);
	let ndc = clip.xy / clip.w;
	return vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5) * uniforms.viewport;
}

@vertex
fn vs(@builtin(vertex_index) v: u32, c: Capsule) -> Fragment {
	var a = (uniforms.view * vec4f(c.a, 1.0)).xyz;
	var b = (uniforms.view * vec4f(c.b, 1.0)).xyz;
	var out: Fragment;
	// cut the part behind the near plane; nothing left draws nothing
	let near = -uniforms.near;
	if (a.z > near && b.z > near) {
		out.position = vec4f(2.0, 2.0, 0.0, 1.0);
		return out;
	}
	if (a.z > near) {
		a = mix(b, a, (near - b.z) / (a.z - b.z));
	} else if (b.z > near) {
		b = mix(a, b, (near - a.z) / (b.z - a.z));
	}
	let pa = pixel(a);
	let pb = pixel(b);
	let span = pb - pa;
	let along = select(vec2f(1.0, 0.0), normalize(span), dot(span, span) > 1e-6);
	let across = vec2f(-along.y, along.x);
	let r = c.radius + 1.0;
	let corner = select(pa - along * r, pb + along * r, (v & 1u) == 1u) + across * r * select(-1.0, 1.0, v > 1u);
	out.position = vec4f(corner.x / uniforms.viewport.x * 2.0 - 1.0, 1.0 - corner.y / uniforms.viewport.y * 2.0, 0.0, 1.0);
	out.a = pa;
	out.b = pb;
	out.depths = vec2f(-a.z, -b.z);
	out.radius = c.radius;
	out.colour = c.colour;
	out.occlude = c.occlude;
	return out;
}

@fragment
fn fs(f: Fragment) -> @location(0) vec4f {
	let p = f.position.xy;
	let span = f.b - f.a;
	let t = select(0.0, clamp(dot(p - f.a, span) / dot(span, span), 0.0, 1.0), dot(span, span) > 1e-6);
	let coverage = clamp(f.radius - distance(p, f.a + span * t) + 0.5, 0.0, 1.0);
	if (coverage <= 0.0) {
		discard;
	}
	if (f.occlude != 0u) {
		// screen-linear in 1 / depth along a segment
		let here = 1.0 / mix(1.0 / f.depths.x, 1.0 / f.depths.y, t);
		let stored = textureLoad(depth, vec2i(p), 0);
		let scene = uniforms.near * pow(uniforms.far / uniforms.near, stored);
		if (stored < 1.0 && here > scene * (1.0 + SLACK)) {
			discard;
		}
	}
	let a = f.colour.a * coverage;
	return vec4f(f.colour.rgb * a, a);
}
