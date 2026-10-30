// every splat the last frame drew over one pixel, with its alpha there, over the frame's visible
// clusters; the host blends them front to back as the frame did

// workgroups of the dispatch, pick.ts's GROUPS; each loops over the visible clusters
const PICK_GROUPS: u32 = 256u;

struct Probe {
	// target pixel, y up from the bottom-left
	pixel: vec2f,
	// the pixel's frustum sides; inside when dot(plane.xyz, p) + plane.w >= 0
	planes: array<vec4f, 4>,
}

// a splat over the pixel: its face toward the camera, its view depth, which orders the blend, the
// view depth where the pixel's ray meets its plane, its alpha at the pixel and its layer
struct Entry {
	normal: vec3f,
	depth: f32,
	meets: f32,
	alpha: f32,
	layer: u32,
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
@group(0) @binding(7) var<uniform> probe: Probe;
@group(0) @binding(8) var<storage, read_write> hits: Hits;

// false only when the box lies wholly outside one side of the pixel
fn under(lo: vec3f, hi: vec3f) -> bool {
	for (var p = 0u; p < 4u; p++) {
		let plane = probe.planes[p];
		let corner = select(lo, hi, plane.xyz >= vec3f(0.0));
		if (dot(plane.xyz, corner) + plane.w < 0.0) {
			return false;
		}
	}
	return true;
}

// the cluster of visible index under the pixel, or none
fn candidate(index: u32, cluster: ptr<function, Cluster>) -> bool {
	*cluster = clusters[work[WORK_LIST + index]];
	let page = pages[(*cluster).page];
	return under(page.origin + (*cluster).boxMin, page.origin + (*cluster).boxMax);
}

// the alpha a drawn splat gives the pixel as raster.wgsl blends it: its quad stops at reach
// sigmas along each axis, and a fragment under 1/255 is discarded
fn coverage(s: Splat, d: Drawn) -> f32 {
	let off = probe.pixel - d.centre;
	let uv = vec2f(dot(off, d.axis) / d.major, dot(off, vec2f(-d.axis.y, d.axis.x)) / d.minor);
	if (any(abs(uv) > vec2f(reach(s.opacity)))) {
		return 0.0;
	}
	let a = s.opacity * exp(-0.5 * dot(uv, uv));
	return select(0.0, a, a >= 1.0 / 255.0);
}

// the splat's thinnest axis, toward the camera
fn face(s: Splat, g: vec4u) -> vec3f {
	let r = rotate(rotation(g));
	let k = select(select(2u, 1u, s.scale.y <= s.scale.z), 0u,
		s.scale.x <= s.scale.y && s.scale.x <= s.scale.z);
	return r[k] * sign(dot(r[k], uniforms.camera - s.position) + 1e-20);
}

// the view depth where the pixel's ray meets the plane of the splat's face, kept within its
// reach of the centre: a splat seen edge on meets the ray far off
fn meets(s: Splat, d: Drawn, normal: vec3f) -> f32 {
	let ndc = probe.pixel / uniforms.viewport * 2.0 - 1.0;
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

@compute @workgroup_size(256)
fn gather(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	for (var index = wid.x; index < work[WORK_VISIBLE]; index += PICK_GROUPS) {
		var cluster: Cluster;
		var s: Splat;
		var g: vec4u;
		if (!candidate(index, &cluster) || t >= cluster.count || !decode(cluster, t, &s, &g)) {
			continue;
		}
		shade(&s);
		var d: Drawn;
		if (!drawn(s, g, &d)) {
			continue;
		}
		let a = coverage(s, d);
		if (a == 0.0) {
			continue;
		}
		let normal = face(s, g);
		let slot = atomicAdd(&hits.count, 1u);
		if (slot < arrayLength(&hits.entries)) {
			hits.entries[slot] = Entry(normal, d.depth, meets(s, d, normal), a, pages[cluster.page].layer);
		}
	}
}
