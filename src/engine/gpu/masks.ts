// masks on the gpu: prisms that act on splats by centre, in group 1 of the passes that test them

import { IN, OUT, relate, type Prism } from '../math/prism.ts';
import type { Colour } from '../types.ts';
import { bufferGroup, bufferLayout } from './buffers.ts';
import { pack4x8unorm } from './layout.ts';

/** u32 words of a record in masks.wgsl */
const MASK_WORDS = 11;
/** f32 stand-in for an open height range */
const FAR = 3e38;
/** cells across past which a mask is tested by every box rather than filed by cell */
const SPAN = 4;
/** masks.wgsl's list entry bit for a mask that acts on every centre of the cluster */
const INSIDE = 0x80000000;

/** a mask as the pool holds it */
export interface Spec {
	prism: Prism;
	/** layers it acts on, 0 for the world */
	targets: ReadonlySet<number>;
	/** what the splats it covers keep, 0 to 1; 0 hides them */
	opacity: number;
	/** mixes their colour toward rgb by a */
	tint: Colour;
}

interface Held extends Spec {
	enabled: boolean;
	/** world min e, n, max e, n of its edges */
	bounds: [number, number, number, number];
	/** world min e, n, max e, n of what it acts on: its bounds, or everywhere when outside */
	area: readonly [number, number, number, number];
}

const EVERYWHERE = [-Infinity, -Infinity, Infinity, Infinity] as const;

export class Masks {
	/** layout of group 1 in the passes that call masks.wgsl's masked() */
	readonly layout: GPUBindGroupLayout;
	#device: GPUDevice;
	#buffer: GPUBuffer;
	#group: GPUBindGroup | null = null;
	#masks = new Map<number, Held>();
	#next = 0;
	#origin: readonly [number, number, number] = [0, 0, 0];
	/** the lists of the last write, as mask ids */
	#lists: number[] = [];
	#grid: Grid | null = null;

	constructor(device: GPUDevice) {
		this.#device = device;
		this.layout = bufferLayout(device, 'masks', GPUShaderStage.COMPUTE, ['read-only-storage']);
		this.#buffer = this.#make(64);
	}

	get group(): GPUBindGroup {
		return (this.#group ??= bufferGroup(this.#device, 'masks', this.layout, [this.#buffer]));
	}

	get size(): number {
		return this.#masks.size;
	}

	/** a new mask's id */
	add(spec: Spec): number {
		this.#hold(++this.#next, spec, true);
		return this.#next;
	}

	/** mask id as spec now, in its place in the list */
	set(id: number, spec: Spec): void {
		const mask = this.#masks.get(id);
		if (mask) this.#hold(id, spec, mask.enabled);
	}

	enable(id: number, enabled: boolean): void {
		const mask = this.#masks.get(id);
		if (mask) mask.enabled = enabled;
	}

	delete(id: number): void {
		if (this.#masks.delete(id)) this.#grid = null;
	}

	/** world min e, n, max e, n of what a mask acts on */
	area(id: number): readonly [number, number, number, number] | undefined {
		return this.#masks.get(id)?.area;
	}

	/**
	 * whether an enabled mask over layer hides every centre in the world box min to max; when none
	 * does, those that may act on some go into listed as entries, in the order they were added
	 */
	relate(layer: number, min: ArrayLike<number>, max: ArrayLike<number>, listed: number[]): boolean {
		for (const id of (this.#grid ??= new Grid(this.#masks)).near(min, max)) {
			const { prism, targets, opacity, enabled, area } = this.#masks.get(id)!;
			if (!enabled || !targets.has(layer)) continue;
			if (max[0] < area[0] || max[1] < area[1] || min[0] > area[2] || min[1] > area[3]) continue;
			const relation = relate(prism, min, max);
			if (relation === OUT) continue;
			if (relation === IN && opacity === 0) return true;
			// an entry: id times 2, odd where the mask acts on every centre
			listed.push(id * 2 + (relation === IN ? 1 : 0));
		}
		// ids count up as masks are added, and the shader composites tints in list order
		listed.sort((a, b) => a - b);
		return false;
	}

	setOrigin(origin: readonly [number, number, number]): void {
		this.#origin = origin;
	}

	/** words before the lists: the records and their edges */
	get listBase(): number {
		let words = this.#masks.size * MASK_WORDS;
		for (const { prism } of this.#masks.values()) words += prism.edges.length;
		return words;
	}

	/** the records, edges and lists, as relate's entries, from listBase on; the last lists when left out */
	write(lists: number[] = this.#lists): void {
		this.#lists = lists;
		const words = new Uint32Array(this.listBase + lists.length);
		const floats = new Float32Array(words.buffer);
		const [ox, oy, oz] = this.#origin;
		const record = new Map<number, number>();
		let edge = this.#masks.size * MASK_WORDS;
		let r = 0;
		for (const [id, { prism, opacity, tint, bounds }] of this.#masks) {
			const { edges, z, outside } = prism;
			const w = r * MASK_WORDS;
			floats.set([bounds[0] - ox, bounds[1] - oy, bounds[2] - ox, bounds[3] - oy], w);
			floats[w + 4] = Number.isFinite(z[0]) ? z[0] - oz : -FAR;
			floats[w + 5] = Number.isFinite(z[1]) ? z[1] - oz : FAR;
			words[w + 6] = edge;
			words[w + 7] = edges.length / 4;
			floats[w + 8] = opacity;
			words[w + 9] = pack4x8unorm(tint);
			words[w + 10] = outside ? 1 : 0;
			for (let k = 0; k < edges.length; k++) floats[edge++] = edges[k] - (k % 2 ? oy : ox);
			record.set(id, r++);
		}
		for (let k = 0; k < lists.length; k++) {
			const entry = lists[k];
			words[edge + k] = (record.get(entry >> 1) ?? 0) | (entry & 1 ? INSIDE : 0);
		}
		if (words.byteLength > this.#buffer.size) {
			this.#buffer.destroy();
			this.#buffer = this.#make(words.byteLength);
			this.#group = null;
		}
		if (words.length) this.#device.queue.writeBuffer(this.#buffer, 0, words);
	}

	destroy(): void {
		this.#buffer.destroy();
	}

	#hold(id: number, spec: Spec, enabled: boolean): void {
		const { edges, outside } = spec.prism;
		const bounds: Held['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
		for (let k = 0; k < edges.length; k += 2) {
			bounds[0] = Math.min(bounds[0], edges[k]);
			bounds[1] = Math.min(bounds[1], edges[k + 1]);
			bounds[2] = Math.max(bounds[2], edges[k]);
			bounds[3] = Math.max(bounds[3], edges[k + 1]);
		}
		this.#masks.set(id, { ...spec, enabled, bounds, area: outside ? EVERYWHERE : bounds });
		this.#grid = null;
	}

	#make(bytes: number): GPUBuffer {
		return this.#device.createBuffer({
			label: 'masks',
			size: Math.max(256, 2 ** Math.ceil(Math.log2(bytes))),
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
	}
}

/** the masks by area: a grid at about a typical mask's size, and those that span many cells */
class Grid {
	#all: number[];
	#cell: number;
	#cells = new Map<string, number[]>();
	#wide: number[] = [];

	constructor(masks: ReadonlyMap<number, Held>) {
		this.#all = [...masks.keys()];
		const sides = [...masks.values()]
			.map(({ area }) => Math.max(area[2] - area[0], area[3] - area[1]))
			.filter(Number.isFinite)
			.sort((a, b) => a - b);
		this.#cell = Math.max(sides[sides.length >> 1] ?? 1, 1e-3);
		for (const [id, { area }] of masks) {
			const [x0, y0, x1, y1] = cells(area[0], area[1], area[2], area[3], this.#cell);
			if (x1 - x0 >= SPAN || y1 - y0 >= SPAN) {
				this.#wide.push(id);
				continue;
			}
			for (let x = x0; x <= x1; x++)
				for (let y = y0; y <= y1; y++) {
					const list = this.#cells.get(`${x},${y}`);
					if (list) list.push(id);
					else this.#cells.set(`${x},${y}`, [id]);
				}
		}
	}

	/** ids of the masks whose area may meet the box min to max, each once */
	near(min: ArrayLike<number>, max: ArrayLike<number>): Iterable<number> {
		const [x0, y0, x1, y1] = cells(min[0], min[1], max[0], max[1], this.#cell);
		// a box over more cells than there are masks: reading them all is cheaper
		if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.#all.length) return this.#all;
		const out = new Set(this.#wide);
		for (let x = x0; x <= x1; x++)
			for (let y = y0; y <= y1; y++)
				for (const id of this.#cells.get(`${x},${y}`) ?? []) out.add(id);
		return out;
	}
}

function cells(x0: number, y0: number, x1: number, y1: number, cell: number) {
	return [
		Math.floor(x0 / cell),
		Math.floor(y0 / cell),
		Math.floor(x1 / cell),
		Math.floor(y1 / cell)
	] as const;
}
