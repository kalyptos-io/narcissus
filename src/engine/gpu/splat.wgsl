// a pool splat decoded, its screen covariance and how the frame draws it, shared by project and
// pick; each declares the uniforms, geometry, colours and pages bindings these read

// ndc reach past the frustum, so splats centred just outside still cover the edge
const GUARD: f32 = 1.3;

// i8 over 127, sign-extended by extractBits on i32
fn code(word: u32, bit: u32) -> f32 {
	return f32(extractBits(i32(word), bit, 8u)) / 127.0;
}

// splat t of a cluster in the floating-origin frame as its masks leave it, its record in g; false
// when a mask hides it
fn decode(cluster: Cluster, t: u32, s: ptr<function, Splat>, g: ptr<function, vec4u>) -> bool {
	let page = pages[cluster.page];
	let rec = cluster.slot + t;
	*g = geometry[rec];
	let w0 = colours[rec * 3u];
	let w1 = colours[rec * 3u + 1u];
	let w2 = colours[rec * 3u + 2u];
	let i = cluster.first + t;
	let quadrant = u32(i >= page.q1) + u32(i >= page.q2) + u32(i >= page.q3);

	var d: Splat;
	d.position = position(page, *g);
	let effect = masked(cluster, d.position);
	if (effect.opacity == 0.0) {
		return false;
	}
	d.opacity = fraction((*g).y, 16u) * fraction(page.factors, 8u * quadrant) * effect.opacity;
	let level = vec3f(fraction((*g).z, 24u), fraction((*g).w, 0u), fraction((*g).w, 8u));
	d.scale = exp(mix(page.scaleMin, page.scaleMax, level));
	d.object = (*g).w >> 16u;
	d.page = cluster.page;
	d.row = i;
	let dc = mix(page.dcMin, page.dcMax, vec3f(fraction(w0, 0u), fraction(w0, 8u), fraction(w0, 16u)));
	// sh[c][m] at 3c + m, gathered per m across the colours
	let k = page.shScale;
	let m0 = vec3f(code(w0, 24u), code(w1, 16u), code(w2, 8u)) * vec3f(k[0].x, k[0].w, k[1].z);
	let m1 = vec3f(code(w1, 0u), code(w1, 24u), code(w2, 16u)) * vec3f(k[0].y, k[1].x, k[1].w);
	let m2 = vec3f(code(w1, 8u), code(w2, 0u), code(w2, 24u)) * vec3f(k[0].z, k[1].y, page.sh8);
	// sh in the layer's frame, so the view direction turns back
	let toward = turn(normalize(d.position - uniforms.camera), page.turn * vec2f(1.0, -1.0));
	d.colour = max(0.5 + C0 * dc + C1 * (-toward.y * m0 + toward.z * m1 - toward.x * m2), vec3f(0.0));
	d.colour = d.colour * (1.0 - effect.tint.a) + effect.tint.rgb;
	d.depth = -(uniforms.view * vec4f(d.position, 1.0)).z;
	*s = d;
	return true;
}

// ewa: the screen covariance B Bᵀ + L of coverage_of, a b c in px²
fn covariance(g: vec4u, by: vec2f, scale: vec3f, viewPos: vec3f) -> vec3f {
	let c = coverage_of(g, by, scale, viewPos);
	let u = vec3f(c.b[0].x, c.b[1].x, c.b[2].x);
	let v = vec3f(c.b[0].y, c.b[1].y, c.b[2].y);
	return vec3f(dot(u, u) + c.low, dot(u, v), dot(v, v) + c.low);
}

// a splat as the frame draws it: its view depth, its centre in pixels from the bottom-left, and
// its quad's axis with the sigmas along it and across
struct Drawn {
	depth: f32,
	centre: vec2f,
	axis: vec2f,
	major: f32,
	minor: f32,
}

// false where the frame draws none of the shaded splat of a page turned by: too faint, out of range,
// centred past the guard band, under half a pixel, or off the screen
fn drawn(s: Splat, g: vec4u, by: vec2f, d: ptr<function, Drawn>) -> bool {
	if (s.opacity < 1.0 / 255.0) {
		return false;
	}
	let viewPos = (uniforms.view * vec4f(s.position, 1.0)).xyz;
	let depth = -viewPos.z;
	if (depth < uniforms.near || depth > uniforms.far) {
		return false;
	}
	let clip = uniforms.proj * vec4f(viewPos, 1.0);
	let ndc = clip.xy / clip.w;
	if (any(abs(ndc) > vec2f(GUARD))) {
		return false;
	}

	let cov = covariance(g, by, s.scale, viewPos);
	let mid = 0.5 * (cov.x + cov.z);
	let rad = length(vec2f(0.5 * (cov.x - cov.z), cov.y));
	let major = sqrt(mid + rad);
	if (3.0 * major < 0.5) {
		return false;
	}
	let minor = sqrt(max(mid - rad, 0.0));
	let angle = 0.5 * atan2(2.0 * cov.y, cov.x - cov.z);
	let axis = vec2f(cos(angle), sin(angle));
	// the quad raster draws; a centre inside the guard band can still miss the screen
	let centre = (ndc * 0.5 + 0.5) * uniforms.viewport;
	let extent = reach(s.opacity) * (abs(axis) * major + abs(axis.yx) * minor);
	if (any(centre + extent < vec2f(0.0)) || any(centre - extent > uniforms.viewport)) {
		return false;
	}
	*d = Drawn(depth, centre, axis, major, minor);
	return true;
}
