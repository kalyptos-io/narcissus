// shared by every engine pass; sizes and word offsets mirror format/spec.ts

const KEY_BITS: u32 = 24u;
// word offsets in the work buffer, layout.ts WORK
const WORK_VISIBLE: u32 = 0u;
const WORK_PROJECTED: u32 = 4u;
const WORK_LIST: u32 = 16u;
// workgroups a dispatch row holds
const GROUPS_X: u32 = 65535u;
const C0: f32 = 0.28209479177387814;
const C1: f32 = 0.4886025119029199;

// floating-origin ENU frame; camera looks down -z of view space
struct FrameUniforms {
	view: mat4x4f,
	proj: mat4x4f,
	viewProj: mat4x4f,
	// inside when dot(plane.xyz, p) + plane.w >= 0
	planes: array<vec4f, 6>,
	camera: vec3f,
	time: f32,
	// render target pixels
	viewport: vec2f,
	focal: vec2f,
	near: f32,
	far: f32,
	lowPass: f32,
	// drawn cluster ids in the pool's list
	clusters: u32,
}

// one resident page; dc and sh ranges are after the colour correction
struct Page {
	origin: vec3f,
	count: u32,
	step: vec3f,
	q1: u32,
	scaleMin: vec3f,
	q2: u32,
	scaleMax: vec3f,
	q3: u32,
	dcMin: vec3f,
	// quadrant k opacity 0-255 at bits 8k
	factors: u32,
	dcMax: vec3f,
	// 0 for the world, else the layer that holds the page
	layer: u32,
	shScale: array<vec4f, 3>,
}

// up to CLUSTER consecutive splats of one page in one pool slot
struct Cluster {
	page: u32,
	// first pool record
	slot: u32,
	// index in the page of its first splat
	first: u32,
	count: u32,
	// extents relative to the page origin
	boxMin: vec3f,
	// word in masks.wgsl's buffer of the list of masks that may hide some of its splats
	maskList: u32,
	boxMax: vec3f,
	maskCount: u32,
}

// a splat on screen; pixels with y up from the bottom-left of the target
struct Projected {
	centre: vec2f,
	// pack2x16float: 1-sigma major axis xy, 1-sigma minor axis xy
	axes: vec2u,
	// pack2x16float: r g, b opacity
	colour: vec2u,
}

// what a shade hook may change; position in the floating-origin frame, depth in view metres
struct Splat {
	position: vec3f,
	depth: f32,
	colour: vec3f,
	opacity: f32,
	scale: vec3f,
}

// the byte of word at bit, 0 to 1
fn fraction(word: u32, bit: u32) -> f32 {
	return f32(extractBits(word, bit, 8u)) / 255.0;
}

// sigmas out to where a gaussian of opacity falls under 1/255, at most 3; the quad raster draws
fn reach(opacity: f32) -> f32 {
	return min(3.0, sqrt(max(2.0 * log(255.0 * opacity), 0.0)));
}
