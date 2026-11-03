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
// tables and attribute streams, then this frame's sample records
@group(0) @binding(10) var<storage, read_write> extension: array<u32>;
var<workgroup> kept: atomic<u32>;
var<workgroup> asked: atomic<u32>;
// the cluster's first projected splat and first sample record
var<workgroup> base: vec2u;

fn coverage_over() {
	atomicAdd(&work[WORK_OVER], 1u);
}

// false when splat t of the cluster cannot show; else its Projected and sort key, and its sample
// record when its shade asked for one
fn shown(
	cluster: Cluster,
	t: u32,
	dest: ptr<function, Projected>,
	key: ptr<function, u32>,
	record: ptr<function, array<u32, RECORD_WORDS>>
) -> bool {
	var s: Splat;
	var g: vec4u;
	if (!decode(cluster, t, &s, &g)) {
		return false;
	}
	shade(&s);
	let turned = pages[cluster.page].turn;
	var d: Drawn;
	if (!drawn(s, g, turned, &d)) {
		return false;
	}
	if (sample_hook != 0u) {
		let viewPos = (uniforms.view * vec4f(s.position, 1.0)).xyz;
		*record = sample_record(s, coverage_of(g, turned, s.scale, viewPos));
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
		var record: array<u32, RECORD_WORDS>;
		if (t < cluster.count) {
			keep = shown(cluster, t, &splat, &key, &record);
		}
		let sampled = keep && sample_hook != 0u;

		// one global atomic per cluster for each count
		var rank = 0u;
		var asking = 0u;
		if (keep) {
			rank = atomicAdd(&kept, 1u);
		}
		if (sampled) {
			asking = atomicAdd(&asked, 1u);
		}
		workgroupBarrier();
		if (t == 0u) {
			base.x = atomicAdd(&work[WORK_PROJECTED], atomicExchange(&kept, 0u));
			let n = atomicExchange(&asked, 0u);
			if (n > 0u) {
				base.y = atomicAdd(&work[WORK_SAMPLED], n);
			}
		}
		let first = workgroupUniformLoad(&base);
		let i = first.x + rank;
		let r = first.y + asking;
		let capacity = arrayLength(&projected);
		if (keep && i < capacity) {
			// past the records the frame holds, the splat draws unsampled
			if (sampled && r < uniforms.recordCount) {
				let at = uniforms.records + r * RECORD_WORDS;
				for (var k = 0u; k < RECORD_WORDS; k++) {
					extension[at + k] = record[k];
				}
				let opacity = unpack2x16float(splat.colour.y).y;
				splat.colour = vec2u(r, pack2x16float(vec2f(0.0, -opacity)));
			}
			projected[i] = splat;
			sort[i] = key;
			sort[capacity + i] = i;
		}
	}
}
