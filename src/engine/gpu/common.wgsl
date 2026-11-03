// shared by every engine pass; sizes and word offsets mirror format/spec.ts

const KEY_BITS: u32 = 24u;
// word offsets in the work buffer, layout.ts WORK
const WORK_VISIBLE: u32 = 0u;
// sample records asked for, kept or not; samples over the coverage estimate in project and raster
const WORK_SAMPLED: u32 = 1u;
const WORK_OVER: u32 = 2u;
const WORK_RASTER_OVER: u32 = 3u;
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
	// extension words: the table directory and the ids it holds, the sample records and how many fit,
	// the clip planes and how many
	tables: u32,
	tableCount: u32,
	records: u32,
	recordCount: u32,
	clips: u32,
	clipCount: u32,
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
	// 0 for the world, else the layer that holds the page; PICKLESS set when pick passes it by
	layer: u32,
	// sh scale of coefficients 0-7, then 8
	shScale: array<vec4f, 2>,
	sh8: f32,
	// extension word of the page's attribute directory (attributes.wgsl), ATTRIBUTE_NONE for none
	attributes: u32,
	// cos and sin of the layer's heading, (1, 0) for the world
	@align(16) turn: vec2f,
}

const PICKLESS: u32 = 0x80000000u;
const ATTRIBUTE_NONE: u32 = 0xffffffffu;

// v turned clockwise seen from above by the angle of cos and sin by
fn turn(v: vec3f, by: vec2f) -> vec3f {
	return vec3f(by.x * v.x + by.y * v.y, by.x * v.y - by.y * v.x, v.z);
}

// a splat's centre in the floating-origin frame from its geometry record
fn position(page: Page, g: vec4u) -> vec3f {
	let q = vec3f(f32(g.x & 0xffffu), f32(g.x >> 16u), f32(g.y & 0xffffu));
	return page.origin + turn(q * page.step, page.turn);
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
	// pack2x16float: r g, b opacity; a negative opacity tags a sampled splat, x its record
	colour: vec2u,
}

// what a shade hook may change; position in the floating-origin frame, depth in view metres
struct Splat {
	position: vec3f,
	depth: f32,
	colour: vec3f,
	opacity: f32,
	scale: vec3f,
	// the host's object id, 0 for none
	object: u32,
	// what pick reports for the splat
	token: u32,
	// its page-table slot and its index in the page, for attribute reads
	page: u32,
	row: u32,
}

// the byte of word at bit, 0 to 1
fn fraction(word: u32, bit: u32) -> f32 {
	return f32(extractBits(word, bit, 8u)) / 255.0;
}

// sigmas out to where a gaussian of opacity falls under 1/255, at most 3; the quad raster draws
fn reach(opacity: f32) -> f32 {
	return min(3.0, sqrt(max(2.0 * log(255.0 * opacity), 0.0)));
}

// smallest three: w x y z with the largest at the stored index
fn rotation(g: vec4u) -> vec4f {
	let v = (vec3f(fraction(g.z, 0u), fraction(g.z, 8u), fraction(g.z, 16u)) - 0.5) * sqrt(2.0);
	let big = sqrt(max(0.0, 1.0 - dot(v, v)));
	switch extractBits(g.y, 24u, 8u) {
		case 0u: {
			return normalize(vec4f(big, v));
		}
		case 1u: {
			return normalize(vec4f(v.x, big, v.yz));
		}
		case 2u: {
			return normalize(vec4f(v.xy, big, v.z));
		}
		default: {
			return normalize(vec4f(v, big));
		}
	}
}

fn rotate(q: vec4f) -> mat3x3f {
	let w = q.x;
	let x = q.y;
	let y = q.z;
	let z = q.w;
	return mat3x3f(
		1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
		2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
		2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
	);
}
