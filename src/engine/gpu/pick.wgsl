// every splat the last frame drew over each probed pixel, with its alpha there, over the frame's
// visible clusters, each cluster decoded once for all probes; the host blends each pixel's front to
// back as the frame did

// workgroups of the dispatch, pick.ts's GROUPS; each loops over the visible clusters
const PICK_GROUPS: u32 = 256u;

struct Probe {
	// target pixel, y up from the bottom-left
	pixel: vec2f,
	// the pixel's frustum sides; inside when dot(plane.xyz, p) + plane.w >= 0
	planes: array<vec4f, 4>,
}

struct Probes {
	count: u32,
	items: array<Probe>,
}

// a splat over a probed pixel: its face toward the camera, its view depth, which orders the blend,
// the view depth where the pixel's ray meets its plane, its alpha at the pixel, its layer, its object,
// the probe's index, the token there, its page-table slot and its row
struct Entry {
	normal: vec3f,
	depth: f32,
	meets: f32,
	alpha: f32,
	layer: u32,
	object: u32,
	probe: u32,
	token: u32,
	page: u32,
	row: u32,
}

// entries past the buffer's length are counted and not kept
struct Hits {
	count: atomic<u32>,
	entries: array<Entry>,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var<uniform> plugins: array<vec4f, 16>;
@group(0) @binding(2) var<storage, read> geometry: array<vec4u>;
@group(0) @binding(3) var<storage, read> colours: array<u32>;
@group(0) @binding(4) var<storage, read> pages: array<Page>;
@group(0) @binding(5) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(6) var<storage, read> work: array<u32>;
@group(0) @binding(7) var<storage, read> probes: Probes;
@group(0) @binding(8) var<storage, read_write> hits: Hits;
@group(0) @binding(9) var<storage, read> extension: array<u32>;

// invocation k tests probe k on the cluster in hand; a loop over all crashes mesa 25.2's lavapipe
var<workgroup> near: atomic<u32>;
var<workgroup> seen: u32;

// false only when the box lies wholly outside one side of probe k's pixel
fn under(lo: vec3f, hi: vec3f, k: u32) -> bool {
	for (var p = 0u; p < 4u; p++) {
		let plane = probes.items[k].planes[p];
		let corner = select(lo, hi, plane.xyz >= vec3f(0.0));
		if (dot(plane.xyz, corner) + plane.w < 0.0) {
			return false;
		}
	}
	return true;
}

// the alpha a drawn splat gives the pixel as raster.wgsl blends it: its quad stops at reach
// sigmas along each axis, and a fragment under 1/255 is discarded
fn coverage(s: Splat, d: Drawn, pixel: vec2f) -> f32 {
	let off = pixel - d.centre;
	let uv = vec2f(dot(off, d.axis) / d.major, dot(off, vec2f(-d.axis.y, d.axis.x)) / d.minor);
	if (any(abs(uv) > vec2f(reach(s.opacity)))) {
		return 0.0;
	}
	let a = s.opacity * exp(-0.5 * dot(uv, uv));
	return select(0.0, a, a >= 1.0 / 255.0);
}

// the frame counted the samples over the coverage estimate
fn coverage_over() {}

// the thinnest axis of a splat of a page turned by, toward the camera
fn face(s: Splat, g: vec4u, by: vec2f) -> vec3f {
	let r = rotate(rotation(g));
	let k = select(select(2u, 1u, s.scale.y <= s.scale.z), 0u,
		s.scale.x <= s.scale.y && s.scale.x <= s.scale.z);
	let axis = turn(r[k], by);
	return axis * sign(dot(axis, uniforms.camera - s.position) + 1e-20);
}

// the view depth where the pixel's ray meets the plane of the splat's face, kept within its
// reach of the centre: a splat seen edge on meets the ray far off
fn meets(s: Splat, d: Drawn, normal: vec3f, pixel: vec2f) -> f32 {
	let ndc = pixel / uniforms.viewport * 2.0 - 1.0;
	let ray = vec3f(ndc.x / uniforms.proj[0].x, ndc.y / uniforms.proj[1].y, -1.0);
	let n = (uniforms.view * vec4f(normal, 0.0)).xyz;
	let centre = (uniforms.view * vec4f(s.position, 1.0)).xyz;
	let across = dot(n, ray);
	if (abs(across) < 1e-6) {
		return d.depth;
	}
	let spread = reach(s.opacity) * max(s.scale.x, max(s.scale.y, s.scale.z));
	return clamp(dot(n, centre) / across, d.depth - spread, d.depth + spread);
}

// an entry for each probed pixel splat t of the cluster covers
fn give(cluster: Cluster, t: u32) {
	var s: Splat;
	var g: vec4u;
	var clip: Clip;
	var d: Drawn;
	var record: array<u32, RECORD_WORDS>;
	if (!show(cluster, t, uniforms.clipCount, &s, &g, &clip, &d, &record)) {
		return;
	}
	let sampled = asks_record(clip);
	let page = pages[cluster.page];
	let normal = face(s, g, page.turn);
	let layer = page.layer & ~PICKLESS;
	for (var k = 0u; k < probes.count; k++) {
		let pixel = probes.items[k].pixel;
		var a = coverage(s, d, pixel);
		var token = s.token;
		if (sampled && a > 0.0) {
			let out = sample_dispatch(record[7] & 0xffffu, sample_of(record, pixel - d.centre, a));
			a = select(0.0, out.colour.a, out.colour.a >= 1.0 / 255.0);
			token = select(token, out.token, sample_hook != 0u);
		}
		if (a == 0.0) {
			continue;
		}
		let slot = atomicAdd(&hits.count, 1u);
		if (slot < arrayLength(&hits.entries)) {
			let at = meets(s, d, normal, pixel);
			hits.entries[slot] = Entry(normal, d.depth, at, a, layer, s.object, k, token, s.page, s.row);
		}
	}
}

@compute @workgroup_size(256)
fn gather(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	for (var index = wid.x; index < work[WORK_VISIBLE]; index += PICK_GROUPS) {
		let cluster = clusters[work[WORK_LIST + index]];
		let page = pages[cluster.page];
		let pickable = (page.layer & PICKLESS) == 0u;
		if (pickable && t < probes.count &&
			under(page.origin + cluster.boxMin, page.origin + cluster.boxMax, t)) {
			atomicStore(&near, 1u);
		}
		workgroupBarrier();
		if (t == 0u) {
			seen = atomicExchange(&near, 0u);
		}
		if (workgroupUniformLoad(&seen) != 0u && t < cluster.count) {
			give(cluster, t);
		}
	}
}
