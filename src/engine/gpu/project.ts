import type { AttributeUse, Shade } from '../plugin.ts';
import type { AttributeRegistry, Declared, StreamType } from '../stream/attributes.ts';
import attributes from './attributes.wgsl?raw';
import clip from './clip.wgsl?raw';
import { bufferGroup, bufferLayout, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import coverage from './coverage.wgsl?raw';
import masks from './masks.wgsl?raw';
import { WORK } from './layout.ts';
import source from './project.wgsl?raw';
import records from './records.wgsl?raw';
import sample from './sample.wgsl?raw';
import splat from './splat.wgsl?raw';
import type { Pool } from './pool.ts';

/** what every pass that runs hooks includes before its own source; the shade's passes add ATTRIBUTES */
export const HOOKED = [common, records, coverage, sample];
export const ATTRIBUTES = attributes;

/**
 * a shade hook as the passes run it: its first uniform slot, and the registry's id of each stream
 * its attributes read, null where the world lacks one
 */
export interface Hooked {
	shade: Shade;
	slot: number;
	streams: readonly (number | null)[];
}

export class Project {
	#device: GPUDevice;
	#layout: GPUBindGroupLayout;
	#pipelineLayout: GPUPipelineLayout;
	#pipeline: GPUComputePipeline | undefined;
	#hooks: readonly Hooked[] = [];
	#resources: GPUBuffer[];
	#group: GPUBindGroup | undefined;
	#bound: GPUBuffer | undefined;
	#pool: Pool;
	#work: GPUBuffer;
	#visible: GPUBuffer;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#device = device;
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
		this.#layout = layout;
		this.#pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		this.#resources = [
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
	}

	/** the next frame's pipeline runs these hooks in order, each reading from its first slot */
	hooks(hooks: readonly Hooked[]): void {
		this.#hooks = hooks;
		this.#pipeline = undefined;
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
		pass.setPipeline((this.#pipeline ??= this.#build()));
		pass.setBindGroup(0, this.#bind());
		// chrome validates indirect args on its gpu process's main thread, a cost every frame
		pass.dispatchWorkgroups(count);
		pass.end();
	}

	/** the group over the extension as it stands: a flush may have replaced its buffer */
	#bind(): GPUBindGroup {
		const buffer = this.#pool.extension.buffer;
		if (this.#bound !== buffer) {
			const resources = [...this.#resources, buffer];
			this.#group = bufferGroup(this.#device, 'project', this.#layout, resources);
			this.#bound = buffer;
		}
		return this.#group!;
	}

	#build(): GPUComputePipeline {
		const code = shaded([...HOOKED, ATTRIBUTES, masks, clip, splat, source], this.#hooks, 'shade');
		const module = this.#device.createShaderModule({ label: 'project', code });
		return this.#device.createComputePipeline({
			label: 'project',
			layout: this.#pipelineLayout,
			compute: { module, entryPoint: 'project' }
		});
	}
}

/**
 * wgsl of parts, the attribute accessors and the hooks, a shade(s) that runs them in order, each
 * from its first slot, and a sample_dispatch(hook, c) that runs the sample hook shade numbered so;
 * a pass that runs only the sample hooks, whose shades never run, reads no attributes
 */
export function shaded(
	parts: string[],
	hooks: readonly Hooked[],
	runs: 'shade' | 'sample'
): string {
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
		...parts,
		...accessors(hooks, runs === 'shade'),
		...hooks.map(({ shade }) => shade.wgsl),
		'fn shade(s: ptr<function, Splat>) {',
		'\tsample_hook = 0u;',
		...calls,
		'}',
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
	return WIDENS[declared.type] === use.type && (declared.components ?? 1) === (use.components ?? 1);
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

/** a lacking stream reads its type's zero, an empty record; attribute_word gives words widened */
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
	const words = Array.from(
		{ length: n },
		(_, c) => `bitcast<${use.type}>(attribute_word((*s).page, (*s).row, ${stream}u, ${c}u))`
	);
	return `${head} ${type} {\n\treturn ${type}(${words.join(', ')});\n}`;
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
