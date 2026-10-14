// workgroups loop over visible clusters, one thread per splat

// ndc reach past the frustum, so splats centred just outside still cover the edge
const GUARD: f32 = 1.3;

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var<uniform> plugins: array<vec4f, 16>;
@group(0) @binding(2) var<storage, read> geometry: array<vec4u>;
@group(0) @binding(3) var<storage, read> colours: array<u32>;
@group(0) @binding(4) var<storage, read> pages: array<Page>;
@group(0) @binding(5) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(6) var<storage, read_write> work: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> projected: array<Projected>;
// keys in [0, capacity), values in [capacity, 2 capacity)
@group(0) @binding(8) var<storage, read_write> sort: array<u32>;

@group(0) @binding(9) var<uniform> visible: u32;
var<workgroup> kept: atomic<u32>;
var<workgroup> base: u32;

// i8 over 127, sign-extended by extractBits on i32
fn code(word: u32, bit: u32) -> f32 {
	return f32(extractBits(i32(word), bit, 8u)) / 127.0;
}

// smallest three: w x y z with the largest at the stored index
fn rotation(g: vec4u) -> vec4f {
	let v = (vec3f(fraction(g.z, 0u), fraction(g.z, 8u), fraction(g.z, 16u)) - 0.5) * sqrt(2.0);
	let big = sqrt(max(0.0, 1.0 - dot(v, v)));
	switch extractBits(g.y, 24u, 8u) {
		case 0u: {
			return normalize(vec4f(big, v));
		}
		case 1u: {
			return normalize(vec4f(v.x, big, v.yz));
		}
		case 2u: {
			return normalize(vec4f(v.xy, big, v.z));
		}
		default: {
			return normalize(vec4f(v, big));
		}
	}
}

fn rotate(q: vec4f) -> mat3x3f {
	let w = q.x;
	let x = q.y;
	let y = q.z;
	let z = q.w;
	return mat3x3f(
		1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
		2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
		2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
	);
}

// false when splat t of the cluster cannot show; else its Projected and sort key
fn shown(cluster: Cluster, t: u32, dest: ptr<function, Projected>, key: ptr<function, u32>) -> bool {
	let page = pages[cluster.page];
	let rec = cluster.slot + t;
	let g = geometry[rec];
	let w0 = colours[rec * 3u];
	let w1 = colours[rec * 3u + 1u];
	let w2 = colours[rec * 3u + 2u];
	let i = cluster.first + t;
	let quadrant = u32(i >= page.q1) + u32(i >= page.q2) + u32(i >= page.q3);

	// decode
	var s: Splat;
	let q = vec3f(f32(g.x & 0xffffu), f32(g.x >> 16u), f32(g.y & 0xffffu));
	s.position = page.origin + q * page.step;
	s.opacity = fraction(g.y, 16u) * fraction(page.factors, 8u * quadrant);
	let level = vec3f(fraction(g.z, 24u), fraction(g.w, 0u), fraction(g.w, 8u));
	s.scale = exp(mix(page.scaleMin, page.scaleMax, level));
	let dc = mix(page.dcMin, page.dcMax, vec3f(fraction(w0, 0u), fraction(w0, 8u), fraction(w0, 16u)));
	// sh[c][m] at 3c + m, gathered per m across the colours
	let k = page.shScale;
	let m0 = vec3f(code(w0, 24u), code(w1, 16u), code(w2, 8u)) * vec3f(k[0].x, k[0].w, k[1].z);
	let m1 = vec3f(code(w1, 0u), code(w1, 24u), code(w2, 16u)) * vec3f(k[0].y, k[1].x, k[1].w);
	let m2 = vec3f(code(w1, 8u), code(w2, 0u), code(w2, 24u)) * vec3f(k[0].z, k[1].y, k[2].x);
	let d = normalize(s.position - uniforms.camera);
	s.colour = max(0.5 + C0 * dc + C1 * (-d.y * m0 + d.z * m1 - d.x * m2), vec3f(0.0));
	s.depth = -(uniforms.view * vec4f(s.position, 1.0)).z;

	shade(&s);
	if (s.opacity < 1.0 / 255.0) {
		return false;
	}

	// project
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

	// ewa: view-space covariance wm wm^T through the jacobian of the pixel projection
	let r = rotate(rotation(g));
	let m = mat3x3f(r[0] * s.scale.x, r[1] * s.scale.y, r[2] * s.scale.z);
	let w = mat3x3f(uniforms.view[0].xyz, uniforms.view[1].xyz, uniforms.view[2].xyz);
	let wm = w * m;
	let focal = uniforms.focal;
	let j0 = vec3f(focal.x / depth, 0.0, focal.x * viewPos.x / (depth * depth));
	let j1 = vec3f(0.0, focal.y / depth, focal.y * viewPos.y / (depth * depth));
	let u = j0 * wm;
	let v = j1 * wm;
	let a = dot(u, u) + uniforms.lowPass;
	let b = dot(u, v);
	let c = dot(v, v) + uniforms.lowPass;
	let mid = 0.5 * (a + c);
	let rad = length(vec2f(0.5 * (a - c), b));
	let major = sqrt(mid + rad);
	if (3.0 * major < 0.5) {
		return false;
	}
	let minor = sqrt(max(mid - rad, 0.0));
	let angle = 0.5 * atan2(2.0 * b, a - c);
	let axis = vec2f(cos(angle), sin(angle));
	// the quad raster draws; a centre inside the guard band can still miss the screen
	let centre = (ndc * 0.5 + 0.5) * uniforms.viewport;
	let extent = reach(s.opacity) * (abs(axis) * major + abs(axis.yx) * minor);
	if (any(centre + extent < vec2f(0.0)) || any(centre - extent > uniforms.viewport)) {
		return false;
	}

	*dest = Projected(
		centre,
		vec2u(pack2x16float(axis * major), pack2x16float(vec2f(-axis.y, axis.x) * minor)),
		vec2u(pack2x16float(s.colour.rg), pack2x16float(vec2f(s.colour.b, s.opacity)))
	);
	let span = clamp(log(depth / uniforms.near) / log(uniforms.far / uniforms.near), 0.0, 1.0);
	*key = u32((1.0 - span) * f32((1u << KEY_BITS) - 1u));
	return true;
}

@compute @workgroup_size(256)
fn project(
	@builtin(workgroup_id) wid: vec3u,
	@builtin(num_workgroups) groups: vec3u,
	@builtin(local_invocation_index) t: u32
) {
	for (var index = wid.y * groups.x + wid.x; index < visible; index += groups.x * groups.y) {
		let cluster = clusters[atomicLoad(&work[WORK_LIST + index])];
		var splat: Projected;
		var key = 0u;
		var keep = false;
		if (t < cluster.count) {
			keep = shown(cluster, t, &splat, &key);
		}

		// one global atomic per cluster
		var rank = 0u;
		if (keep) {
			rank = atomicAdd(&kept, 1u);
		}
		workgroupBarrier();
		if (t == 0u) {
			base = atomicAdd(&work[WORK_PROJECTED], atomicExchange(&kept, 0u));
		}
		let i = workgroupUniformLoad(&base) + rank;
		let capacity = arrayLength(&projected);
		if (keep && i < capacity) {
			projected[i] = splat;
			sort[i] = key;
			sort[capacity + i] = i;
		}
	}
}
