// one thread per listed cluster

// mirrors spec.ts WORK
const WORK_VISIBLE: u32 = 0u;
const WORK_LIST: u32 = 16u;

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

// some quadrant the cluster's splats overlap has a nonzero factor
fn lit(page: Page, cluster: Cluster) -> bool {
	var starts = array<u32, 5>(0u, page.q1, page.q2, page.q3, page.count);
	let end = cluster.first + cluster.count;
	for (var k = 0u; k < 4u; k++) {
		let overlaps = max(starts[k], cluster.first) < min(starts[k + 1u], end);
		if (overlaps && extractBits(page.factors, 8u * k, 8u) != 0u) {
			return true;
		}
	}
	return false;
}

@compute @workgroup_size(64)
fn cull(@builtin(global_invocation_id) id: vec3u) {
	if (id.x >= uniforms.clusters) {
		return;
	}
	let slot = list[id.x];
	let cluster = clusters[slot];
	let page = pages[cluster.page];
	if (!inside(page.origin + cluster.boxMin, page.origin + cluster.boxMax) || !lit(page, cluster)) {
		return;
	}
	atomicStore(&work[WORK_LIST + atomicAdd(&work[WORK_VISIBLE], 1u)], slot);
}
