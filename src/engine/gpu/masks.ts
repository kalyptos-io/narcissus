// masks on the gpu: prisms that hide splats by centre, in group 1 of the passes that test them

import { IN, CROSS, relate, type Prism } from '../math/prism.ts';
import { bufferGroup, bufferLayout } from './buffers.ts';

/** u32 words of a record in masks.wgsl */
const MASK_WORDS = 8;
/** f32 stand-in for an open height range */
const FAR = 3e38;
/** cells across past which a mask is tested by every box rather than filed by cell */
const SPAN = 4;

interface Held {
	prism: Prism;
	/** layers it hides splats of, 0 for the world */
	targets: ReadonlySet<number>;
	enabled: boolean;
	/** world min e, n, max e, n of its polygon */
	area: [number, number, number, number];
}

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
	add(prism: Prism, targets: ReadonlySet<number>): number {
		const { polygon } = prism;
		const area: Held['area'] = [Infinity, Infinity, -Infinity, -Infinity];
		for (let k = 0; k < polygon.length; k += 2) {
			area[0] = Math.min(area[0], polygon[k]);
			area[1] = Math.min(area[1], polygon[k + 1]);
			area[2] = Math.max(area[2], polygon[k]);
			area[3] = Math.max(area[3], polygon[k + 1]);
		}
		this.#masks.set(++this.#next, { prism, targets, enabled: true, area });
		this.#grid = null;
		return this.#next;
	}

	enable(id: number, enabled: boolean): void {
		const mask = this.#masks.get(id);
		if (mask) mask.enabled = enabled;
	}

	delete(id: number): void {
		if (this.#masks.delete(id)) this.#grid = null;
	}

	/** world min e, n, max e, n of a mask's polygon */
	area(id: number): readonly [number, number, number, number] | undefined {
		return this.#masks.get(id)?.area;
	}

	/**
	 * whether an enabled mask over layer hides every centre in the world box min to max; when none
	 * does, the ids of those that may hide some go into crossing
	 */
	relate(
		layer: number,
		min: ArrayLike<number>,
		max: ArrayLike<number>,
		crossing: number[]
	): boolean {
		for (const id of (this.#grid ??= new Grid(this.#masks)).near(min, max)) {
			const { prism, targets, enabled, area } = this.#masks.get(id)!;
			if (!enabled || !targets.has(layer)) continue;
			if (max[0] < area[0] || max[1] < area[1] || min[0] > area[2] || min[1] > area[3]) continue;
			const relation = relate(prism, min, max);
			if (relation === IN) return true;
			if (relation === CROSS) crossing.push(id);
		}
		return false;
	}

	setOrigin(origin: readonly [number, number, number]): void {
		this.#origin = origin;
	}

	/** words before the lists: the records and their vertices */
	get listBase(): number {
		let words = this.#masks.size * MASK_WORDS;
		for (const { prism } of this.#masks.values()) words += prism.polygon.length;
		return words;
	}

	/** the records, vertices and lists, as mask ids from listBase on; the last lists when left out */
	write(lists: number[] = this.#lists): void {
		this.#lists = lists;
		const words = new Uint32Array(this.listBase + lists.length);
		const floats = new Float32Array(words.buffer);
		const [ox, oy, oz] = this.#origin;
		const record = new Map<number, number>();
		let vertex = this.#masks.size * MASK_WORDS;
		let r = 0;
		for (const [id, { prism, area }] of this.#masks) {
			const { polygon, z } = prism;
			const w = r * MASK_WORDS;
			floats.set([area[0] - ox, area[1] - oy, area[2] - ox, area[3] - oy], w);
			floats[w + 4] = Number.isFinite(z[0]) ? z[0] - oz : -FAR;
			floats[w + 5] = Number.isFinite(z[1]) ? z[1] - oz : FAR;
			words[w + 6] = vertex;
			words[w + 7] = polygon.length / 2;
			for (let k = 0; k < polygon.length; k += 2) {
				floats[vertex++] = polygon[k] - ox;
				floats[vertex++] = polygon[k + 1] - oy;
			}
			record.set(id, r++);
		}
		for (let k = 0; k < lists.length; k++) words[vertex + k] = record.get(lists[k]) ?? 0;
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
