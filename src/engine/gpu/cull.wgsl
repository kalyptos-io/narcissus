// one thread per listed cluster

@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var<storage, read> pages: array<Page>;
@group(0) @binding(2) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(3) var<storage, read> list: array<u32>;
@group(0) @binding(4) var<storage, read_write> work: array<atomic<u32>>;

// false only when the box lies wholly outside one plane
fn inside(lo: vec3f, hi: vec3f) -> bool {
	for (var p = 0u; p < 6u; p++) {
		let plane = uniforms.planes[p];
		let corner = select(lo, hi, plane.xyz >= vec3f(0.0));
		if (dot(plane.xyz, corner) + plane.w < 0.0) {
			return false;
		}
	}
	return true;
}

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3u) {
	if (id.x >= uniforms.clusters) {
		return;
	}
	let slot = list[id.x];
	let cluster = clusters[slot];
	let page = pages[cluster.page];
	if (!inside(page.origin + cluster.boxMin, page.origin + cluster.boxMax)) {
		return;
	}
	atomicStore(&work[WORK_LIST + atomicAdd(&work[WORK_VISIBLE], 1u)], slot);
}
