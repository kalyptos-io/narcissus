// the nearest solid splat under one pixel, over the last frame's visible clusters

// workgroups of the dispatch, pick.ts's GROUPS; each loops over the visible clusters
const PICK_GROUPS: u32 = 256u;
// least alpha at the pixel of a splat that counts as the surface
const SOLID: f32 = 0.5;

struct Probe {
	// target pixel, y up from the bottom-left
	pixel: vec2f,
	// the pixel's frustum sides; inside when dot(plane.xyz, p) + plane.w >= 0
	planes: array<vec4f, 4>,
}

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var<uniform> plugins: array<vec4f, 16>;
@group(0) @binding(2) var<storage, read> geometry: array<vec4u>;
@group(0) @binding(3) var<storage, read> colours: array<u32>;
@group(0) @binding(4) var<storage, read> pages: array<Page>;
@group(0) @binding(5) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(6) var<storage, read> work: array<u32>;
@group(0) @binding(7) var<uniform> probe: Probe;
// view depth bits of the nearest hit, then its layer, then its normal
@group(0) @binding(8) var<storage, read_write> hit: array<atomic<u32>>;

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

// splat t of the cluster draws the pixel solid; its view depth and decoded splat then
fn covers(cluster: Cluster, t: u32, s: ptr<function, Splat>, g: ptr<function, vec4u>) -> bool {
	if (!decode(cluster, t, s, g)) {
		return false;
	}
	shade(s);
	let viewPos = (uniforms.view * vec4f((*s).position, 1.0)).xyz;
	let depth = -viewPos.z;
	if ((*s).opacity < SOLID || depth < uniforms.near || depth > uniforms.far) {
		return false;
	}
	let clip = uniforms.proj * vec4f(viewPos, 1.0);
	let centre = (clip.xy / clip.w * 0.5 + 0.5) * uniforms.viewport;
	let cov = covariance(*g, (*s).scale, viewPos);
	let d = probe.pixel - centre;
	let power = (cov.z * d.x * d.x - 2.0 * cov.y * d.x * d.y + cov.x * d.y * d.y) / (cov.x * cov.z - cov.y * cov.y);
	(*s).depth = depth;
	return (*s).opacity * exp(-0.5 * power) >= SOLID;
}

// the cluster of visible index under the pixel, or none
fn candidate(index: u32, cluster: ptr<function, Cluster>) -> bool {
	*cluster = clusters[work[WORK_LIST + index]];
	let page = pages[(*cluster).page];
	return under(page.origin + (*cluster).boxMin, page.origin + (*cluster).boxMax);
}

@compute @workgroup_size(256)
fn nearest(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	for (var index = wid.x; index < work[WORK_VISIBLE]; index += PICK_GROUPS) {
		var cluster: Cluster;
		var s: Splat;
		var g: vec4u;
		if (candidate(index, &cluster) && t < cluster.count && covers(cluster, t, &s, &g)) {
			atomicMin(&hit[0], bitcast<u32>(s.depth));
		}
	}
}

// the splat at the nearest depth writes its layer and its thinnest axis, toward the camera
@compute @workgroup_size(256)
fn surface(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	let nearest = atomicLoad(&hit[0]);
	for (var index = wid.x; index < work[WORK_VISIBLE]; index += PICK_GROUPS) {
		var cluster: Cluster;
		var s: Splat;
		var g: vec4u;
		if (candidate(index, &cluster) && t < cluster.count && covers(cluster, t, &s, &g) &&
			bitcast<u32>(s.depth) == nearest) {
			let r = rotate(rotation(g));
			let k = select(select(2u, 1u, s.scale.y <= s.scale.z), 0u,
				s.scale.x <= s.scale.y && s.scale.x <= s.scale.z);
			let normal = r[k] * sign(dot(r[k], uniforms.camera - s.position) + 1e-20);
			atomicStore(&hit[1], pages[cluster.page].layer);
			atomicStore(&hit[2], bitcast<u32>(normal.x));
			atomicStore(&hit[3], bitcast<u32>(normal.y));
			atomicStore(&hit[4], bitcast<u32>(normal.z));
		}
	}
}
