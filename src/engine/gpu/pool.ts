// resident pages on the gpu: records in CLUSTER-splat slots, the page and cluster tables

import {
	CLUSTER,
	CLUSTER_WORDS,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PAGE_WORDS,
	PARAMS,
	slots
} from '../../format/spec.ts';
import type { DecodedPage } from '../../format/types.ts';
import type { Drawn } from '../types.ts';

/** u32 word of Page.factors */
const FACTORS = 19;
/** a word gap below which two changed ranges of a table go up as one write */
const MERGE_WORDS = 1024;

interface Entry {
	/** null once uploaded */
	page: DecodedPage | null;
	count: number;
	/** cluster c of the page sits in slots[c] */
	slots: number[];
	/** page-table slot */
	table: number;
	/** page origin in world metres */
	base: [number, number, number];
	factors: number;
}

// decoded pages arrive transferred from workers, never on shared memory
const owned = (words: Uint32Array) => words as Uint32Array<ArrayBuffer>;

/** word ranges of a cpu mirror changed since the last flush */
class Dirty {
	#ranges: [number, number][] = [];

	mark(start: number, end: number): void {
		this.#ranges.push([start, end]);
	}

	clear(): void {
		this.#ranges = [];
	}

	/** the changed words of mirror into buffer, as few writes as the gaps allow */
	flush(queue: GPUQueue, buffer: GPUBuffer, mirror: Uint32Array<ArrayBuffer>): void {
		const ranges = this.#ranges.sort((a, b) => a[0] - b[0]);
		this.#ranges = [];
		for (let i = 0; i < ranges.length;) {
			const start = ranges[i][0];
			let end = ranges[i++][1];
			while (i < ranges.length && ranges[i][0] <= end + MERGE_WORDS) {
				end = Math.max(end, ranges[i++][1]);
			}
			queue.writeBuffer(buffer, start * 4, mirror, start, end - start);
		}
	}
}

export class Pool {
	/** GEOMETRY_WORDS per record */
	readonly geometry!: GPUBuffer;
	/** COLOUR_WORDS per record */
	readonly colour!: GPUBuffer;
	/** Page per table slot */
	readonly pages!: GPUBuffer;
	/** Cluster per slot */
	readonly clusters!: GPUBuffer;
	/** drawn cluster ids, `listed` of them, the cull's input */
	readonly list!: GPUBuffer;
	listed = 0;
	/** splats */
	readonly capacity: number;

	#device: GPUDevice;
	// map order is draw recency, least recently drawn first
	#entries = new Map<number, Entry>();
	#queue = new Set<number>();
	/** 1 per cluster slot in use */
	#taken: Uint8Array;
	#free: number;
	#tables: number[];
	#used = 0;
	#origin: [number, number, number] = [0, 0, 0];
	// mirrors of pages and clusters, flushed once a draw: a write per change floods the gpu process
	#table: Uint32Array<ArrayBuffer>;
	#tableFloats: Float32Array;
	#tableDirty = new Dirty();
	#clusterWords: Uint32Array<ArrayBuffer>;
	#clusterFloats: Float32Array;
	#clusterDirty = new Dirty();
	#list: Uint32Array<ArrayBuffer>;

	constructor(device: GPUDevice, capacity: number) {
		this.capacity = capacity;
		this.#device = device;
		const slots = this.slots;
		// copy-src lets tests and debugging read the pool back
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
		const make = (label: string, size: number) => device.createBuffer({ label, size, usage });
		this.geometry = make('pool geometry', capacity * GEOMETRY_WORDS * 4);
		this.colour = make('pool colour', capacity * COLOUR_WORDS * 4);
		this.pages = make('pool pages', slots * PAGE_WORDS * 4);
		this.clusters = make('pool clusters', slots * CLUSTER_WORDS * 4);
		this.list = make('pool list', slots * 4);
		this.#taken = new Uint8Array(slots);
		this.#free = slots;
		this.#tables = Array.from({ length: slots }, (_, k) => slots - 1 - k);
		this.#table = new Uint32Array(slots * PAGE_WORDS);
		this.#tableFloats = new Float32Array(this.#table.buffer);
		this.#clusterWords = new Uint32Array(slots * CLUSTER_WORDS);
		this.#clusterFloats = new Float32Array(this.#clusterWords.buffer);
		this.#list = new Uint32Array(slots);
	}

	/** clusters the pool can hold */
	get slots(): number {
		return this.capacity / CLUSTER;
	}

	/** splats held, queued or uploaded */
	get used(): number {
		return this.#used;
	}

	get bytes(): number {
		const buffers = [this.geometry, this.colour, this.pages, this.clusters, this.list];
		return buffers.reduce((sum, b) => sum + b.size, 0);
	}

	/** uploaded and drawable */
	has(id: number): boolean {
		const entry = this.#entries.get(id);
		return entry !== undefined && entry.page === null;
	}

	/** queued or uploaded */
	holds(id: number): boolean {
		return this.#entries.has(id);
	}

	/** ids uploaded */
	*ids(): Iterable<number> {
		for (const [id, entry] of this.#entries) if (entry.page === null) yield id;
	}

	/**
	 * queues page id of the unit with south-west corner (e, n), evicting the least recently drawn
	 * pages keep rejects; false when it cannot fit even then
	 */
	add(
		id: number,
		page: DecodedPage,
		unit: readonly [number, number],
		keep: (id: number) => boolean
	): boolean {
		if (this.#entries.has(id)) return true;
		// at least one slot, so page-table slots never run out before cluster slots
		const need = slots(page.count) / CLUSTER;
		if (!this.#fit(need, keep)) return false;
		const o = PARAMS.origin;
		this.#entries.set(id, {
			page,
			count: page.count,
			slots: this.#take(need),
			table: this.#tables.pop()!,
			base: [page.params[o] + unit[0], page.params[o + 1] + unit[1], page.params[o + 2]],
			factors: 0
		});
		this.#queue.add(id);
		this.#used += page.count;
		return true;
	}

	remove(id: number): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		this.#entries.delete(id);
		this.#queue.delete(id);
		this.#used -= entry.count;
		for (const slot of entry.slots) this.#taken[slot] = 0;
		this.#free += entry.slots.length;
		this.#tables.push(entry.table);
		// the gpu list may name its clusters until the next draw
		if (entry.page === null && entry.factors !== 0) this.#setFactors(entry, 0);
	}

	/** pages queued and not yet uploaded */
	get queued(): number {
		return this.#queue.size;
	}

	/** writes queued pages until about maxBytes went up; returns the bytes written */
	upload(maxBytes: number): number {
		let written = 0;
		for (const id of this.#queue) {
			if (written >= maxBytes) break;
			written += this.#write(this.#entries.get(id)!);
			this.#queue.delete(id);
		}
		return written;
	}

	/** the pages to draw with their quadrant factors; rewrites the factors and the cluster list */
	draw(drawn: Drawn[]): void {
		let listed = 0;
		for (const { id, factors } of drawn) {
			const entry = this.#entries.get(id);
			if (!entry || entry.page !== null) continue;
			if (entry.factors !== factors) this.#setFactors(entry, factors);
			this.#entries.delete(id);
			this.#entries.set(id, entry);
			this.#list.set(entry.slots, listed);
			listed += entry.slots.length;
		}
		this.listed = listed;
		const queue = this.#device.queue;
		this.#tableDirty.flush(queue, this.pages, this.#table);
		this.#clusterDirty.flush(queue, this.clusters, this.#clusterWords);
		queue.writeBuffer(this.list, 0, this.#list, 0, listed);
	}

	/** world position of the floating origin; rewrites every page origin */
	setOrigin(origin: readonly [number, number, number]): void {
		this.#origin = [origin[0], origin[1], origin[2]];
		for (const entry of this.#entries.values()) if (entry.page === null) this.#place(entry);
		this.#device.queue.writeBuffer(this.pages, 0, this.#table);
		this.#tableDirty.clear();
	}

	destroy(): void {
		const buffers = [this.geometry, this.colour, this.pages, this.clusters, this.list];
		for (const b of buffers) b.destroy();
	}

	/** frees the least recently drawn uploaded pages keep rejects until need slots are free */
	#fit(need: number, keep: (id: number) => boolean): boolean {
		let free = this.#free;
		if (free >= need) return true;
		const evict: number[] = [];
		for (const [id, entry] of this.#entries) {
			if (entry.page !== null || keep(id)) continue;
			evict.push(id);
			free += entry.slots.length;
			if (free >= need) break;
		}
		if (free < need) return false;
		for (const id of evict) this.remove(id);
		return true;
	}

	#write(entry: Entry): number {
		const page = entry.page!;
		const { slots } = entry;
		const queue = this.#device.queue;
		const n = slots.length;

		// cluster entries
		const words = this.#clusterWords;
		const floats = this.#clusterFloats;
		for (let c = 0; c < n; c++) {
			const w = slots[c] * CLUSTER_WORDS;
			words.fill(0, w, w + CLUSTER_WORDS);
			words[w] = entry.table;
			words[w + 1] = slots[c] * CLUSTER;
			words[w + 2] = c * CLUSTER;
			words[w + 3] = Math.max(0, Math.min(CLUSTER, page.count - c * CLUSTER));
			floats.set(page.clusters.subarray(c * 6, c * 6 + 3), w + 4);
			floats.set(page.clusters.subarray(c * 6 + 3, c * 6 + 6), w + 8);
		}

		// runs of consecutive slots go up in one write each
		for (let c = 0; c < n;) {
			let k = 1;
			while (c + k < n && slots[c + k] === slots[c] + k) k++;
			const first = c * CLUSTER;
			const splats = Math.min((c + k) * CLUSTER, page.count) - first;
			const record = slots[c] * CLUSTER;
			queue.writeBuffer(
				this.geometry,
				record * GEOMETRY_WORDS * 4,
				owned(page.geometry),
				first * GEOMETRY_WORDS,
				splats * GEOMETRY_WORDS
			);
			queue.writeBuffer(
				this.colour,
				record * COLOUR_WORDS * 4,
				owned(page.colour),
				first * COLOUR_WORDS,
				splats * COLOUR_WORDS
			);
			this.#clusterDirty.mark(slots[c] * CLUSTER_WORDS, (slots[c] + k) * CLUSTER_WORDS);
			c += k;
		}

		// page entry, layout of common.wgsl's Page
		const w = entry.table * PAGE_WORDS;
		const table = this.#table;
		const f = this.#tableFloats;
		const p = page.params;
		const [q1, q2, q3] = page.quadrants;
		table.fill(0, w, w + PAGE_WORDS);
		this.#place(entry);
		table[w + 3] = page.count;
		f.set(p.subarray(PARAMS.step, PARAMS.step + 3), w + 4);
		table[w + 7] = q1;
		f.set(p.subarray(PARAMS.scaleMin, PARAMS.scaleMin + 3), w + 8);
		table[w + 11] = q2;
		f.set(p.subarray(PARAMS.scaleMax, PARAMS.scaleMax + 3), w + 12);
		table[w + 15] = q3;
		f.set(p.subarray(PARAMS.dcMin, PARAMS.dcMin + 3), w + 16);
		f.set(p.subarray(PARAMS.dcMax, PARAMS.dcMax + 3), w + 20);
		f.set(p.subarray(PARAMS.shScale, PARAMS.shScale + 9), w + 24);
		this.#tableDirty.mark(w, w + PAGE_WORDS);

		entry.page = null;
		const records = page.count * (GEOMETRY_WORDS + COLOUR_WORDS) * 4;
		return records + n * CLUSTER_WORDS * 4 + PAGE_WORDS * 4;
	}

	/** origin in the floating frame, summed in float64 before the f32 store */
	#place(entry: Entry): void {
		const w = entry.table * PAGE_WORDS;
		for (let k = 0; k < 3; k++) this.#tableFloats[w + k] = entry.base[k] - this.#origin[k];
	}

	#setFactors(entry: Entry, factors: number): void {
		entry.factors = factors;
		const word = entry.table * PAGE_WORDS + FACTORS;
		this.#table[word] = factors;
		this.#tableDirty.mark(word, word + 1);
	}

	/** need free slots: one run when the pool has one, else the lowest free ones */
	#take(need: number): number[] {
		const taken = this.#taken;
		let at = -1;
		// first fit scans all slots, cheap at a few adds a frame
		for (let s = 0, run = 0; s < taken.length; s++) {
			run = taken[s] ? 0 : run + 1;
			if (run === need) {
				at = s - need + 1;
				break;
			}
		}
		const out: number[] = [];
		if (at >= 0) for (let s = at; s < at + need; s++) out.push(s);
		else for (let s = 0; out.length < need; s++) if (!taken[s]) out.push(s);
		for (const s of out) taken[s] = 1;
		this.#free -= need;
		return out;
	}
}
