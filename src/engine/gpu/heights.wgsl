// the top of the solid drawn splats over a square of 1 m cells; one workgroup per listed cluster

const GROUP: u32 = 64u;

struct Area {
	// south-west corner, floating-origin frame
	corner: vec2f,
	cells: u32,
	clusters: u32,
	// least opacity and largest scale in metres of a splat that counts
	opacity: f32,
	scale: f32,
}

@group(0) @binding(0) var<uniform> area: Area;
@group(0) @binding(1) var<storage, read> pages: array<Page>;
@group(0) @binding(2) var<storage, read> clusters: array<Cluster>;
@group(0) @binding(3) var<storage, read> list: array<u32>;
@group(0) @binding(4) var<storage, read> geometry: array<vec4u>;
@group(0) @binding(5) var<storage, read_write> tops: array<atomic<u32>>;

// order-preserving bits of z, never 0, which marks an empty cell
fn ordered(z: f32) -> u32 {
	let bits = bitcast<u32>(z);
	return select(bits | 0x80000000u, ~bits, z < 0.0);
}

@compute @workgroup_size(64)
fn heights(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	let index = wid.y * GROUPS_X + wid.x;
	if (index >= area.clusters) {
		return;
	}
	let cluster = clusters[list[index]];
	let page = pages[cluster.page];
	let size = f32(area.cells);
	let lo = page.origin.xy + cluster.boxMin.xy - area.corner;
	let hi = page.origin.xy + cluster.boxMax.xy - area.corner;
	if (any(hi < vec2f(0.0)) || any(lo >= vec2f(size))) {
		return;
	}
	for (var k = t; k < cluster.count; k += GROUP) {
		let g = geometry[cluster.slot + k];
		let i = cluster.first + k;
		let quadrant = u32(i >= page.q1) + u32(i >= page.q2) + u32(i >= page.q3);
		let opacity = fraction(g.y, 16u) * fraction(page.factors, 8u * quadrant);
		let level = vec3f(fraction(g.z, 24u), fraction(g.w, 0u), fraction(g.w, 8u));
		let scale = exp(mix(page.scaleMin, page.scaleMax, level));
		if (opacity < area.opacity || max(scale.x, max(scale.y, scale.z)) > area.scale) {
			continue;
		}
		let q = vec3f(f32(g.x & 0xffffu), f32(g.x >> 16u), f32(g.y & 0xffffu));
		let p = page.origin + q * page.step;
		let cell = floor(p.xy - area.corner);
		if (any(cell < vec2f(0.0)) || any(cell >= vec2f(size))) {
			continue;
		}
		let c = vec2u(cell);
		atomicMax(&tops[c.y * area.cells + c.x], ordered(p.z));
	}
}
