// a pool splat decoded, what the clips leave of it, its screen covariance and how the frame draws
// it, shared by project and pick; each declares the uniforms, geometry, colours and pages bindings
// these read, and includes clip.wgsl

// ndc reach past the frustum, so splats centred just outside still cover the edge
const GUARD: f32 = 1.3;

// i8 over 127, sign-extended by extractBits on i32
fn code(word: u32, bit: u32) -> f32 {
	return f32(extractBits(i32(word), bit, 8u)) / 127.0;
}

// the record decode() read last, for source()
var<private> decoded: vec4u;

// splat t of a cluster in the floating-origin frame as its masks leave it, its record in g; false
// when a mask hides it
fn decode(cluster: Cluster, t: u32, s: ptr<function, Splat>, g: ptr<function, vec4u>) -> bool {
	let page = pages[cluster.page];
	let rec = cluster.slot + t;
	*g = geometry[rec];
	decoded = *g;
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

// false where one of count planes from extension word at keeps none of splat s, its record g, of a
// page turned by; else clip holds the planes it crosses in its source coordinates. a splat crossing
// more than a Clip holds is cut by its centre on the rest
fn clip_splat(at: u32, count: u32, s: Splat, g: vec4u, by: vec2f, clip: ptr<function, Clip>) -> bool {
	(*clip).count = 0u;
	if (count == 0u) {
		return true;
	}
	let r = rotate(rotation(g));
	let m = mat3x3f(turn(r[0], by) * s.scale.x, turn(r[1], by) * s.scale.y, turn(r[2], by) * s.scale.z);
	for (var k = 0u; k < count; k++) {
		let plane = clip_plane(at, k);
		// the plane's normal in sigmas along each source axis
		let n = plane.xyz * m;
		let sigma = length(n);
		let d = dot(plane.xyz, s.position) + plane.w;
		if (d < -CLIP_REACH * sigma) {
			return false;
		}
		if (d < CLIP_REACH * sigma) {
			if ((*clip).count < 2u) {
				(*clip).planes[(*clip).count] = vec4f(n, d) / sigma;
				(*clip).count++;
			} else if (d < 0.0) {
				return false;
			}
		}
	}
	return true;
}

// p of the floating-origin frame in the source coordinates of s, the splat decode() read last:
// sigmas from its centre along each of its scale axes, which are orthogonal
fn source(s: ptr<function, Splat>, p: vec3f) -> vec3f {
	let r = rotate(rotation(decoded));
	let by = pages[(*s).page].turn;
	let d = p - (*s).position;
	return vec3f(dot(d, turn(r[0], by)), dot(d, turn(r[1], by)), dot(d, turn(r[2], by))) / (*s).scale;
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
