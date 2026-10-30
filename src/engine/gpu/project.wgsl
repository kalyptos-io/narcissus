// workgroups loop over visible clusters, one thread per splat

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
	var d: Drawn;
	if (!drawn(s, g, &d)) {
		return false;
	}
	*dest = Projected(
		d.centre,
		vec2u(pack2x16float(d.axis * d.major), pack2x16float(vec2f(-d.axis.y, d.axis.x) * d.minor)),
		vec2u(pack2x16float(s.colour.rg), pack2x16float(vec2f(s.colour.b, s.opacity)))
	);
	let span = clamp(log(d.depth / uniforms.near) / log(uniforms.far / uniforms.near), 0.0, 1.0);
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
