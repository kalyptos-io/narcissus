// the per-frame buffers the passes hand each other; layouts in common.wgsl and layout.ts

import { FRAME_UNIFORM_BYTES, PLUGIN_VEC4S, PROJECTED_WORDS, WORK } from './layout.ts';

export interface FrameBuffers {
	/** splats one frame may project */
	capacity: number;
	/** FrameUniforms */
	uniforms: GPUBuffer;
	/** counters and indirect args (WORK), then visible cluster ids */
	work: GPUBuffer;
	/** capacity Projected */
	projected: GPUBuffer;
	/** keys, values, keys', values': capacity u32 each */
	sort: GPUBuffer;
	/** PLUGIN_VEC4S vec4f for shade hooks */
	plugins: GPUBuffer;
	bytes: number;
	destroy(): void;
}

/** clusters bounds the visible list: every cluster the pool can hold */
export function frameBuffers(device: GPUDevice, capacity: number, clusters: number): FrameBuffers {
	const make = (label: string, size: number, usage: number) =>
		device.createBuffer({ label, size, usage });
	const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
	const list = [
		make('frame uniforms', FRAME_UNIFORM_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
		make('work', (WORK.list + clusters) * 4, storage | GPUBufferUsage.INDIRECT),
		make('projected', capacity * PROJECTED_WORDS * 4, storage),
		make('sort', capacity * 16, storage),
		make('plugins', PLUGIN_VEC4S * 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST)
	];
	const [uniforms, work, projected, sort, plugins] = list;
	return {
		capacity,
		uniforms,
		work,
		projected,
		sort,
		plugins,
		bytes: list.reduce((sum, b) => sum + b.size, 0),
		destroy: () => list.forEach((b) => b.destroy())
	};
}

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
