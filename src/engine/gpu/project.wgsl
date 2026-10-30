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

// false when splat t of the cluster cannot show; else its Projected and sort key
fn shown(cluster: Cluster, t: u32, dest: ptr<function, Projected>, key: ptr<function, u32>) -> bool {
	var s: Splat;
	var g: vec4u;
	if (!decode(cluster, t, &s, &g)) {
		return false;
	}
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

	let cov = covariance(g, s.scale, viewPos);
	let a = cov.x;
	let b = cov.y;
	let c = cov.z;
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
