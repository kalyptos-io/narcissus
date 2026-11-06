// the per-frame buffers the passes hand each other; layouts in common.wgsl and layout.ts

import { FRAME_UNIFORM_BYTES, PLUGIN_VEC4S, PROJECTED_WORDS, WORK } from './layout.ts';

export interface FrameBuffers {
	/** splats one frame may project */
	capacity: number;
	/** FrameUniforms */
	uniforms: GPUBuffer;
	/** counters and indirect args (WORK), then visible cluster ids */
	work: GPUBuffer;
	visible: GPUBuffer;
	/** capacity Projected */
	projected: GPUBuffer;
	/** keys, values, keys', values': capacity u32 each */
	sort: GPUBuffer;
	/** PLUGIN_VEC4S vec4f for shade hooks */
	plugins: GPUBuffer;
	readonly bytes: number;
	destroy(): void;
}

/** clusters bounds the visible list: every cluster the pool can hold */
export function frameBuffers(device: GPUDevice, capacity: number, clusters: number): FrameBuffers {
	const uniform = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
	const make = (label: string, size: number) =>
		device.createBuffer({ label, size, usage: uniform });
	const buffers: FrameBuffers = {
		uniforms: make('frame uniforms', FRAME_UNIFORM_BYTES),
		plugins: make('plugins', PLUGIN_VEC4S * 16),
		visible: make('visible clusters', 4),
		...sized(device, capacity, clusters),
		get bytes() {
			return all(this).reduce((sum, b) => sum + b.size, 0);
		},
		destroy() {
			for (const b of all(this)) b.destroy();
		}
	};
	return buffers;
}

/** buffers' sized ones made again for capacity and clusters, empty; frames in flight keep the old */
export function growFrame(
	device: GPUDevice,
	buffers: FrameBuffers,
	capacity: number,
	clusters: number
): void {
	const { work, projected, sort } = buffers;
	Object.assign(buffers, sized(device, capacity, clusters));
	for (const b of [work, projected, sort]) b.destroy();
}

function sized(device: GPUDevice, capacity: number, clusters: number) {
	const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
	const make = (label: string, size: number, usage: number) =>
		device.createBuffer({ label, size, usage });
	return {
		capacity,
		work: make('work', (WORK.list + clusters) * 4, storage | GPUBufferUsage.INDIRECT),
		projected: make('projected', capacity * PROJECTED_WORDS * 4, storage),
		sort: make('sort', capacity * 16, storage)
	};
}

const all = (b: FrameBuffers) => [b.uniforms, b.work, b.projected, b.sort, b.plugins, b.visible];

/** a layout of whole buffers of types at bindings 0, 1, .. */
export function bufferLayout(
	device: GPUDevice,
	label: string,
	visibility: number,
	types: GPUBufferBindingType[]
): GPUBindGroupLayout {
	return device.createBindGroupLayout({
		label,
		entries: types.map((type, binding) => ({ binding, visibility, buffer: { type } }))
	});
}

/** a bufferLayout's group over buffers, in binding order */
export function bufferGroup(
	device: GPUDevice,
	label: string,
	layout: GPUBindGroupLayout,
	buffers: GPUBuffer[]
): GPUBindGroup {
	return device.createBindGroup({
		label,
		layout,
		entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } }))
	});
}

/** a bufferGroup over buffers() as they stand, made again when one is replaced, as the extension's on grow */
export function liveGroup(
	device: GPUDevice,
	label: string,
	layout: GPUBindGroupLayout,
	buffers: () => GPUBuffer[]
): () => GPUBindGroup {
	let bound: GPUBuffer[] = [];
	let group: GPUBindGroup | undefined;
	return () => {
		const now = buffers();
		if (!group || now.some((buffer, k) => buffer !== bound[k])) {
			group = bufferGroup(device, label, layout, now);
			bound = now;
		}
		return group;
	};
}
