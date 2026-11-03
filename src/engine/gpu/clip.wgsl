// the planes of engine.addClip() as clips.ts writes them into the pass's extension from word at: a
// vec4f of f32 each, its unit normal and offset in the floating-origin frame; a splat is kept where
// dot(xyz, p) + w >= 0 for every plane

// sigmas from a plane past which a splat lies wholly to one side of it
const CLIP_REACH: f32 = 3.0;
const CLIP_IN: u32 = 0u;
const CLIP_ACROSS: u32 = 1u;
const CLIP_OUT: u32 = 2u;

fn clip_plane(at: u32, k: u32) -> vec4f {
	let w = at + 4u * k;
	return bitcast<vec4f>(vec4u(extension[w], extension[w + 1u], extension[w + 2u], extension[w + 3u]));
}

// how the box lo to hi of the centres of splats that reach at most reach metres lies to the planes:
// CLIP_IN where every plane keeps it whole, CLIP_OUT where one keeps none of it, else CLIP_ACROSS
fn clip_box(at: u32, count: u32, lo: vec3f, hi: vec3f, reach: f32) -> u32 {
	var relation = CLIP_IN;
	for (var k = 0u; k < count; k++) {
		let plane = clip_plane(at, k);
		let up = plane.xyz >= vec3f(0.0);
		if (dot(plane.xyz, select(lo, hi, up)) + plane.w < -reach) {
			return CLIP_OUT;
		}
		if (dot(plane.xyz, select(hi, lo, up)) + plane.w < reach) {
			relation = CLIP_ACROSS;
		}
	}
	return relation;
}

// the farthest a splat of the page reaches from its centre, in metres
fn clip_reach(page: Page) -> f32 {
	return CLIP_REACH * exp(max(page.scaleMax.x, max(page.scaleMax.y, page.scaleMax.z)));
}

// whether every plane keeps p
fn clip_keeps(at: u32, count: u32, p: vec3f) -> bool {
	for (var k = 0u; k < count; k++) {
		let plane = clip_plane(at, k);
		if (dot(plane.xyz, p) + plane.w < 0.0) {
			return false;
		}
	}
	return true;
}
