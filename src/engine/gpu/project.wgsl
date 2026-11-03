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

// what a shown splat wants of the frame's sample records
const RECORD_NONE: u32 = 0u;
const RECORD_CENTRED: u32 = 1u;
const RECORD_CUT: u32 = 2u;

fn coverage_over() {
	atomicAdd(&work[WORK_OVER], 1u);
}

// false when splat t of the cluster cannot show, tested against clips of the frame's planes; else
// its Projected and sort key, and its sample record where it asks for one, *wants then
// RECORD_CENTRED, or RECORD_CUT where a plane it crosses cuts its centre
fn projected_of(
	cluster: Cluster,
	t: u32,
	clips: u32,
	dest: ptr<function, Projected>,
	key: ptr<function, u32>,
	record: ptr<function, array<u32, RECORD_WORDS>>,
	wants: ptr<function, u32>
) -> bool {
	var s: Splat;
	var g: vec4u;
	var clip: Clip;
	var d: Drawn;
	if (!show(cluster, t, clips, &s, &g, &clip, &d, record)) {
		return false;
	}
	if (asks_record(clip)) {
		let cut = (clip.count > 0u && clip.planes[0].w < 0.0) || (clip.count > 1u && clip.planes[1].w < 0.0);
		*wants = select(RECORD_CENTRED, RECORD_CUT, cut);
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
		let page = pages[cluster.page];
		let lo = page.origin + cluster.boxMin;
		let hi = page.origin + cluster.boxMax;
		// a cluster every plane keeps whole tests none of its splats
		let across = clip_box(uniforms.clips, uniforms.clipCount, lo, hi, clip_reach(page)) != CLIP_IN;
		let clips = select(0u, uniforms.clipCount, across);
		var splat: Projected;
		var key = 0u;
		var keep = false;
		var record: array<u32, RECORD_WORDS>;
		var wants = RECORD_NONE;
		if (t < cluster.count) {
			keep = projected_of(cluster, t, clips, &splat, &key, &record, &wants);
		}
		let sampled = keep && wants != RECORD_NONE;

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
			// past the frame's records the splat draws unsampled, or not at all where a plane cuts its centre
			if (sampled && r < uniforms.recordCount) {
				let at = uniforms.records + r * RECORD_WORDS;
				for (var k = 0u; k < RECORD_WORDS; k++) {
					extension[at + k] = record[k];
				}
				let opacity = unpack2x16float(splat.colour.y).y;
				splat.colour = vec2u(r, pack2x16float(vec2f(0.0, -opacity)));
			} else if (wants == RECORD_CUT) {
				splat.colour.y = pack2x16float(vec2f(unpack2x16float(splat.colour.y).x, 0.0));
			}
			projected[i] = splat;
			sort[i] = key;
			sort[capacity + i] = i;
		}
	}
}
