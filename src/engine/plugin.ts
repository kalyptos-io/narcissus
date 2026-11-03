// the engine's extension seam: per-splat shade hooks and full-screen posts

/** one rendered frame as plugins see it; matrices are column-major in the floating-origin frame */
export interface Frame {
	/** ms, performance clock */
	time: number;
	/** render target size in pixels */
	width: number;
	height: number;
	view: Float32Array;
	proj: Float32Array;
	near: number;
	far: number;
	/** camera position, floating-origin frame */
	camera: Float32Array;
	/** the floating origin, in world coordinates */
	origin: readonly [number, number, number];
}

/**
 * a per-splat hook in the projection pass. wgsl defines `fn <name>(s: ptr<function, Splat>,
 * u: array<vec4f, <uniforms>>)` over common.wgsl's Splat; opacity 0 culls the splat. with sample,
 * it also defines `fn <name>_sample(c: Sample, u: array<vec4f, <uniforms>>) -> Sampled`, which
 * draws each pixel of the splats it passes to sample_request (docs/plugins.md)
 */
export interface Shade {
	name: string;
	/** vec4f slots this hook reads */
	uniforms: number;
	wgsl: string;
	/** fills out (uniforms * 4 floats) before each frame */
	update(frame: Frame, out: Float32Array): void;
	/** attribute streams this hook reads, by the name world.json declares */
	attributes?: readonly AttributeUse[];
	/** true when wgsl also defines the Sample hook <name>_sample */
	sample?: boolean;
}

export interface AttributeUse {
	stream: string;
	/** the WGSL identifier: the hook reads it as attr_<as>(s) */
	as: string;
	/**
	 * what attr_<as> returns: u32 for a u8, u16 or u32 stream, i32 for i8 to i32, f32 for f16 and
	 * f32, each with the stream's components; records for a records stream
	 */
	type: 'u32' | 'i32' | 'f32' | 'records';
	/** 1 to 4, 1 when left out; a fixed stream of another count is lacking */
	components?: number;
	/** a world that lacks the stream disables the hook, else its rows take the default */
	required?: boolean;
}

export interface PostPass {
	/**
	 * colour is the frame composited over the sky; depth (depth16unorm) holds the nearest drawn
	 * splat's span t from near to far in log depth, so view depth is near * (far / near) ** t, 1
	 * where none drew; null when not asked for. a pass may also draw into depth as an attachment,
	 * and later posts see what it drew
	 */
	run(
		encoder: GPUCommandEncoder,
		frame: Frame,
		colour: GPUTextureView,
		depth: GPUTextureView | null,
		target: GPUTextureView
	): void;
	destroy(): void;
}

/** a full-screen pass after the splats; posts run by order, then install order, the last one writes the canvas */
export interface Post {
	name: string;
	depth?: boolean;
	/** lower runs first; 0 when left out */
	order?: number;
	setup(device: GPUDevice, format: GPUTextureFormat): PostPass;
}

export interface Host {
	shade(hook: Shade): () => void;
	post(pass: Post): () => void;
	/** a read-only table of u32 words, readable by every hook as table(id, i) */
	table(words: number): Table;
}

export interface Table {
	readonly id: number;
	/** copies words in at word offset at; uploaded before the next frame */
	write(at: number, words: Uint32Array): void;
	destroy(): void;
}

/** installs itself and returns its uninstall */
export type Plugin = (host: Host) => () => void;
