import type { AttributeUse, Shade } from '../plugin.ts';
import type { AttributeRegistry, Declared, StreamType } from '../stream/attributes.ts';
import attributes from './attributes.wgsl?raw';
import clip from './clip.wgsl?raw';
import { bufferLayout, liveGroup, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import coverage from './coverage.wgsl?raw';
import masks from './masks.wgsl?raw';
import { WORK } from './layout.ts';
import source from './project.wgsl?raw';
import records from './records.wgsl?raw';
import sample from './sample.wgsl?raw';
import show from './show.wgsl?raw';
import splat from './splat.wgsl?raw';
import type { Pool } from './pool.ts';

/**
 * a shade hook as the passes run it: its first uniform slot, and the registry's id of each stream
 * its attributes read, null where the world lacks one
 */
export interface Hooked {
	shade: Shade;
	slot: number;
	streams: readonly (number | null)[];
}

/** a compute pipeline over a pass's source and the shade hooks it runs, built lazily after a change */
export class HookedPipeline {
	#device: GPUDevice;
	#layout: GPUPipelineLayout;
	#source: string;
	#label: string;
	#entryPoint: string;
	#code: string;
	#pipeline: GPUComputePipeline | undefined;

	constructor(
		device: GPUDevice,
		layout: GPUPipelineLayout,
		source: string,
		label: string,
		entryPoint: string
	) {
		this.#device = device;
		this.#layout = layout;
		this.#source = source;
		this.#label = label;
		this.#entryPoint = entryPoint;
		this.#code = shaded(source, [], 'shade');
	}

	hooks(hooks: readonly Hooked[]): void {
		const code = shaded(this.#source, hooks, 'shade');
		if (code === this.#code) return;
		this.#code = code;
		this.#pipeline = undefined;
	}

	get pipeline(): GPUComputePipeline {
		return (this.#pipeline ??= this.#device.createComputePipeline({
			label: this.#label,
			layout: this.#layout,
			compute: {
				module: this.#device.createShaderModule({ label: this.#label, code: this.#code }),
				entryPoint: this.#entryPoint
			}
		}));
	}
}

export class Project {
	#pipeline: HookedPipeline;
	#group: () => GPUBindGroup;
	#pool: Pool;
	#work: GPUBuffer;
	#visible: GPUBuffer;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#pool = pool;
		this.#work = buffers.work;
		this.#visible = buffers.visible;
		const layout = bufferLayout(device, 'project', GPUShaderStage.COMPUTE, [
			'uniform',
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage',
			'storage',
			'storage',
			'uniform',
			'storage'
		]);
		const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		this.#pipeline = new HookedPipeline(device, pipelineLayout, source, 'project', 'project');
		const fixed = [
			buffers.uniforms,
			buffers.plugins,
			pool.geometry,
			pool.colour,
			pool.pages,
			pool.clusters,
			buffers.work,
			buffers.projected,
			buffers.sort,
			buffers.visible
		];
		this.#group = liveGroup(device, 'project', layout, () => [...fixed, pool.extension.buffer]);
	}

	/** the next frame's pipeline runs these hooks in order, each reading from its first slot */
	hooks(hooks: readonly Hooked[]): void {
		this.#pipeline.hooks(hooks);
	}

	encode(
		encoder: GPUCommandEncoder,
		visible: number,
		timestamps?: GPUComputePassTimestampWrites
	): void {
		// a uniform count keeps the loop uniform across each workgroup
		encoder.copyBufferToBuffer(this.#work, WORK.visible * 4, this.#visible, 0, 4);
		// a stale count changes parallelism only; the shader still visits every current cluster
		const count = Math.max(
			1,
			Math.min(128, this.#pool.listed, visible ? Math.max(32, Math.ceil(visible / 16)) : 128)
		);
		const pass = encoder.beginComputePass({ label: 'project', timestampWrites: timestamps });
		pass.setPipeline(this.#pipeline.pipeline);
		pass.setBindGroup(0, this.#group());
		// chrome validates indirect args on its gpu process's main thread, a cost every frame
		pass.dispatchWorkgroups(count);
		pass.end();
	}
}

/**
 * wgsl of the hook library, the attribute accessors and the hooks before a pass's source, a shade(s)
 * that runs them in order, each from its first slot, and a sample_dispatch(hook, c) that runs the
 * sample hook shade numbered so; a pass that runs only the sample hooks gets theirs alone, numbered
 * as shade() numbers them, with no shade() and no attribute reads
 */
export function shaded(source: string, hooks: readonly Hooked[], runs: 'shade' | 'sample'): string {
	const shades = runs === 'shade';
	const included = shades ? hooks : hooks.filter(({ shade }) => shade.sample);
	const args = ({ shade, slot }: Hooked) => {
		const slots = Array.from({ length: shade.uniforms }, (_, k) => `plugins[${slot + k}]`);
		return `array<vec4f, ${shade.uniforms}>(${slots.join(', ')})`;
	};
	const calls = hooks.flatMap((hook, k) => [
		`\tsample_asker = ${hook.shade.sample ? k + 1 : 0}u;`,
		`\t${hook.shade.name}(s, ${args(hook)});`
	]);
	const cases = hooks.flatMap((hook, k) =>
		hook.shade.sample
			? [
					`\t\tcase ${k + 1}u: {`,
					`\t\t\treturn ${hook.shade.name}_sample(c, ${args(hook)});`,
					'\t\t}'
				]
			: []
	);
	return [
		common,
		records,
		coverage,
		sample,
		...(shades ? [attributes, masks, clip, splat, show] : []),
		source,
		...accessors(included, shades),
		...included.map(({ shade }) => shade.wgsl),
		...(shades
			? ['fn shade(s: ptr<function, Splat>) {', '\tsample_hook = 0u;', ...calls, '}']
			: []),
		'fn sample_dispatch(hook: u32, c: Sample) -> Sampled {',
		'\tswitch hook {',
		...cases,
		'\t\tdefault: {',
		'\t\t\treturn Sampled(vec4f(c.colour * c.alpha, c.alpha), 0u);',
		'\t\t}',
		'\t}',
		'}'
	].join('\n');
}

/** the type each fixed stream's type widens to */
const WIDENS: Record<Exclude<StreamType, 'records'>, AttributeUse['type']> = {
	u8: 'u32',
	u16: 'u32',
	u32: 'u32',
	i8: 'i32',
	i16: 'i32',
	i32: 'i32',
	f16: 'f32',
	f32: 'f32'
};

/** whether a hook reads a stream so declared as use says */
export function fits(use: AttributeUse, declared: Declared): boolean {
	if (declared.type === 'records' || use.type === 'records') return declared.type === use.type;
	return WIDENS[declared.type] === use.type && declared.components === (use.components ?? 1);
}

/** attr_<as>(s) for each name the hooks read, the first hook that names it giving it */
function accessors(hooks: readonly Hooked[], reads: boolean): string[] {
	const made = new Map<string, string>();
	for (const { shade, streams } of hooks)
		(shade.attributes ?? []).forEach((use, k) => {
			if (!made.has(use.as)) made.set(use.as, accessor(use, reads ? streams[k] : null));
		});
	return [...made.values()];
}

/** a lacking stream reads its type's zero, an empty record; attribute_words gives words widened */
function accessor(use: AttributeUse, stream: number | null): string {
	const head = `fn attr_${use.as}(s: ptr<function, Splat>) ->`;
	if (use.type === 'records') {
		const read =
			stream === null ? 'Record(0u, 0u)' : `attribute_record((*s).page, (*s).row, ${stream}u)`;
		return `${head} Record {\n\treturn ${read};\n}`;
	}
	const n = use.components ?? 1;
	const type = n === 1 ? use.type : `vec${n}<${use.type}>`;
	if (stream === null) return `${head} ${type} {\n\treturn ${type}();\n}`;
	const words = Array.from({ length: n }, (_, c) => `bitcast<${use.type}>(w[${c}])`);
	const read = `let w = attribute_words((*s).page, (*s).row, ${stream}u);`;
	return `${head} ${type} {\n\t${read}\n\treturn ${type}(${words.join(', ')});\n}`;
}

/**
 * the streams of a hook's attributes in the registry's open world, each taken there, null where
 * the world lacks it or declares it otherwise; null in all when it lacks one the hook requires
 */
export function streams(shade: Shade, registry: AttributeRegistry): (number | null)[] | null {
	const taken: (number | null)[] = [];
	for (const use of shade.attributes ?? []) {
		const declared = registry.declared(use.stream);
		const id = declared && fits(use, declared) ? registry.use(use.stream, !!use.required) : -1;
		if (id < 0 && use.required) {
			for (const stream of taken) if (stream !== null) registry.release(stream);
			return null;
		}
		taken.push(id < 0 ? null : id);
	}
	return taken;
}
