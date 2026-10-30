// resident pages on the gpu: records in CLUSTER-splat slots, the page and cluster tables

import {
	CLUSTER,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PARAMS,
	type DecodedPage
} from '../../format/index.ts';
import { CLUSTER_WORDS, PAGE_WORDS, slots } from './layout.ts';
import { Masks } from './masks.ts';
import type { Drawn } from '../types.ts';

/** u32 words of Page.factors and Page.layer */
const FACTORS = 19;
const LAYER = 23;
/** u32 words of Cluster.maskList and Cluster.maskCount */
const MASK_LIST = 7;
const MASK_COUNT = 11;
const NONE: readonly number[] = [];
/** a word gap below which two changed ranges of a table go up as one write */
const MERGE_WORDS = 1024;

interface Entry {
	id: number;
	previous: Entry | null;
	next: Entry | null;
	/** null once uploaded */
	page: DecodedPage | null;
	/** cluster c of the page sits in slots[c] */
	slots: number[];
	active: number[];
	mask: number;
	/** page-table slot */
	table: number;
	/** page origin in world metres */
	base: [number, number, number];
	factors: number;
	/** 0 for the world's pages; a layer's are pinned: never evicted, kept through clear */
	layer: number;
}

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
	geometry!: GPUBuffer;
	/** COLOUR_WORDS per record */
	colour!: GPUBuffer;
	/** Page per table slot */
	pages!: GPUBuffer;
	/** Cluster per slot */
	clusters!: GPUBuffer;
	// cull input excludes clusters with only zero quadrant factors
	list!: GPUBuffer;
	listed = 0;
	/** splats */
	capacity: number;
	readonly masks: Masks;

	#device: GPUDevice;
	#entries = new Map<number, Entry>();
	#oldest: Entry | null = null;
	#newest: Entry | null = null;
	#queue = new Set<number>();
	/** 1 per cluster slot in use */
	#taken: Uint8Array;
	#free: number;
	// slots below this are occupied
	#firstFree = 0;
	#tables: number[];
	#origin: [number, number, number] = [0, 0, 0];
	// mirrors of pages and clusters, flushed once a draw: a write per change floods the gpu process
	#table: Uint32Array<ArrayBuffer>;
	#tableFloats: Float32Array;
	#tableDirty = new Dirty();
	#clusterWords: Uint32Array<ArrayBuffer>;
	#clusterFloats: Float32Array;
	#clusterDirty = new Dirty();
	#list: Uint32Array<ArrayBuffer>;
	#drawn: Entry[] = [];
	/** per slot: 1 when a mask hides every splat, else the masks that may hide some */
	#hidden: Uint8Array;
	#masked: (readonly number[])[];
	#maskedChanged = false;

	constructor(device: GPUDevice, capacity: number, masks = new Masks(device)) {
		this.capacity = capacity;
		this.masks = masks;
		this.#device = device;
		const slots = this.slots;
		this.#allocate();
		this.#taken = new Uint8Array(slots);
		this.#free = slots;
		this.#tables = Array.from({ length: slots }, (_, k) => slots - 1 - k);
		this.#table = new Uint32Array(slots * PAGE_WORDS);
		this.#tableFloats = new Float32Array(this.#table.buffer);
		this.#clusterWords = new Uint32Array(slots * CLUSTER_WORDS);
		this.#clusterFloats = new Float32Array(this.#clusterWords.buffer);
		this.#list = new Uint32Array(slots);
		this.#hidden = new Uint8Array(slots);
		this.#masked = new Array<readonly number[]>(slots).fill(NONE);
	}

	/** clusters the pool can hold */
	get slots(): number {
		return this.capacity / CLUSTER;
	}

	get bytes(): number {
		return this.#buffers().reduce((sum, b) => sum + b.size, 0);
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
		for (let entry = this.#oldest; entry; entry = entry.next)
			if (entry.page === null) yield entry.id;
	}

	/**
	 * queues page id of the unit with south-west corner (e, n), evicting the least recently drawn
	 * pages keep rejects; false when it cannot fit even then. a page of a layer other than 0 is pinned
	 */
	add(
		id: number,
		page: DecodedPage,
		unit: readonly [number, number],
		keep: (id: number) => boolean,
		layer = 0
	): boolean {
		if (this.#entries.has(id)) return true;
		// at least one slot, so page-table slots never run out before cluster slots
		const need = slots(page.count) / CLUSTER;
		if (!this.#fit(need, keep)) return false;
		const o = PARAMS.origin;
		const entry: Entry = {
			id,
			previous: null,
			next: null,
			page,
			slots: this.#take(need),
			active: [],
			mask: 0,
			table: this.#tables.pop()!,
			base: [page.params[o] + unit[0], page.params[o + 1] + unit[1], page.params[o + 2]],
			factors: 0,
			layer
		};
		this.#entries.set(id, entry);
		this.#touch(entry);
		this.#queue.add(id);
		return true;
	}

	remove(id: number): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		this.#unlink(entry);
		this.#entries.delete(id);
		this.#queue.delete(id);
		for (const slot of entry.slots) {
			this.#taken[slot] = 0;
			this.#hidden[slot] = 0;
			if (this.#masked[slot].length) this.#maskedChanged = true;
			this.#masked[slot] = NONE;
		}
		this.#firstFree = Math.min(this.#firstFree, entry.slots[0]);
		this.#free += entry.slots.length;
		this.#tables.push(entry.table);
		// the gpu list may name its clusters until the next draw
		if (entry.page === null && entry.factors !== 0) this.#setFactors(entry, 0);
	}

	/** removes every page but the pinned */
	clear(): void {
		for (const entry of this.#entries.values()) if (entry.layer === 0) this.remove(entry.id);
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
		let count = 0;
		let changed = false;
		for (const { id, factors } of drawn) {
			const entry = this.#entries.get(id);
			if (!entry || entry.page !== null) continue;
			const active = entry.active;
			if (entry.factors !== factors || entry.mask < 0) this.#setFactors(entry, factors);
			changed ||= active !== entry.active;
			this.#touch(entry);
			changed ||= this.#drawn[count] !== entry;
			this.#drawn[count++] = entry;
			if (changed) this.#list.set(entry.active, listed);
			listed += entry.active.length;
		}
		changed ||= this.#drawn.length !== count;
		this.#drawn.length = count;
		this.listed = listed;
		if (this.#maskedChanged) this.#flushMasks();
		const queue = this.#device.queue;
		this.#tableDirty.flush(queue, this.pages, this.#table);
		this.#clusterDirty.flush(queue, this.clusters, this.#clusterWords);
		if (changed && listed) queue.writeBuffer(this.list, 0, this.#list, 0, listed);
	}

	/** world position of the floating origin; rewrites every page origin */
	setOrigin(origin: readonly [number, number, number]): void {
		this.#origin = [origin[0], origin[1], origin[2]];
		for (const entry of this.#entries.values()) if (entry.page === null) this.#place(entry);
		this.#device.queue.writeBuffer(this.pages, 0, this.#table);
		this.#tableDirty.clear();
		this.masks.setOrigin(this.#origin);
		if (this.masks.size) this.masks.write();
	}

	/** relates the clusters of uploaded pages over the world area min e, n, max e, n to the masks again */
	remask(area: readonly [number, number, number, number]): void {
		const floats = this.#clusterFloats;
		for (const entry of this.#entries.values()) {
			if (entry.page !== null) continue;
			const meets = entry.slots.some((slot) => {
				const w = slot * CLUSTER_WORDS;
				const [x0, y0] = [entry.base[0] + floats[w + 4], entry.base[1] + floats[w + 5]];
				const [x1, y1] = [entry.base[0] + floats[w + 8], entry.base[1] + floats[w + 9]];
				return x1 >= area[0] && y1 >= area[1] && x0 <= area[2] && y0 <= area[3];
			});
			if (meets) this.#relate(entry);
		}
		// the records move when masks come and go, so the lists' indices do too
		this.#maskedChanged = true;
	}

	/** room for capacity splats, the pages held staying in place; new buffers, so new bind groups */
	grow(capacity: number): void {
		if (capacity <= this.capacity) return;
		const before = this.slots;
		const old = this.#buffers();
		this.capacity = capacity;
		this.#allocate();
		// queued writes run before the copy, and pending dirty ranges flush into the new buffers
		const encoder = this.#device.createCommandEncoder({ label: 'pool grow' });
		this.#buffers().forEach((buffer, k) =>
			encoder.copyBufferToBuffer(old[k], 0, buffer, 0, old[k].size)
		);
		this.#device.queue.submit([encoder.finish()]);
		for (const buffer of old) buffer.destroy();

		const slots = this.slots;
		const taken = new Uint8Array(slots);
		taken.set(this.#taken);
		this.#taken = taken;
		this.#free += slots - before;
		for (let s = slots - 1; s >= before; s--) this.#tables.push(s);
		const table = new Uint32Array(slots * PAGE_WORDS);
		table.set(this.#table);
		this.#table = table;
		this.#tableFloats = new Float32Array(table.buffer);
		const clusterWords = new Uint32Array(slots * CLUSTER_WORDS);
		clusterWords.set(this.#clusterWords);
		this.#clusterWords = clusterWords;
		this.#clusterFloats = new Float32Array(clusterWords.buffer);
		const list = new Uint32Array(slots);
		list.set(this.#list);
		this.#list = list;
		const hidden = new Uint8Array(slots);
		hidden.set(this.#hidden);
		this.#hidden = hidden;
		for (let s = before; s < slots; s++) this.#masked.push(NONE);
	}

	destroy(): void {
		for (const b of this.#buffers()) b.destroy();
		this.masks.destroy();
	}

	#buffers(): GPUBuffer[] {
		return [this.geometry, this.colour, this.pages, this.clusters, this.list];
	}

	#allocate(): void {
		const { capacity, slots } = this;
		// copy-src lets the pool grow, and tests and debugging read it back
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
		const make = (label: string, size: number) => this.#device.createBuffer({ label, size, usage });
		this.geometry = make('pool geometry', capacity * GEOMETRY_WORDS * 4);
		this.colour = make('pool colour', capacity * COLOUR_WORDS * 4);
		this.pages = make('pool pages', slots * PAGE_WORDS * 4);
		this.clusters = make('pool clusters', slots * CLUSTER_WORDS * 4);
		this.list = make('pool list', slots * 4);
	}

	#unlink(entry: Entry): void {
		if (entry.previous) entry.previous.next = entry.next;
		else if (this.#oldest === entry) this.#oldest = entry.next;
		if (entry.next) entry.next.previous = entry.previous;
		else if (this.#newest === entry) this.#newest = entry.previous;
		entry.previous = null;
		entry.next = null;
	}

	#touch(entry: Entry): void {
		if (this.#newest === entry) return;
		this.#unlink(entry);
		entry.previous = this.#newest;
		if (this.#newest) this.#newest.next = entry;
		else this.#oldest = entry;
		this.#newest = entry;
	}

	/** frees the least recently drawn uploaded pages keep rejects until need slots are free */
	#fit(need: number, keep: (id: number) => boolean): boolean {
		let free = this.#free;
		if (free >= need) return true;
		const evict: number[] = [];
		for (let entry = this.#oldest; entry; entry = entry.next) {
			if (entry.page !== null || entry.layer !== 0 || keep(entry.id)) continue;
			evict.push(entry.id);
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
			for (let k = 0; k < 3; k++) {
				floats[w + 4 + k] = page.clusters[c * 6 + k];
				floats[w + 8 + k] = page.clusters[c * 6 + 3 + k];
			}
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
				page.geometry,
				first * GEOMETRY_WORDS,
				splats * GEOMETRY_WORDS
			);
			queue.writeBuffer(
				this.colour,
				record * COLOUR_WORDS * 4,
				page.colour,
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
		table[w + LAYER] = entry.layer;
		f.set(p.subarray(PARAMS.shScale, PARAMS.shScale + 9), w + 24);
		this.#tableDirty.mark(w, w + PAGE_WORDS);

		entry.page = null;
		if (this.masks.size) this.#relate(entry);
		const records = page.count * (GEOMETRY_WORDS + COLOUR_WORDS) * 4;
		return records + n * CLUSTER_WORDS * 4 + PAGE_WORDS * 4;
	}

	/** origin in the floating frame, summed in float64 before the f32 store */
	#place(entry: Entry): void {
		const w = entry.table * PAGE_WORDS;
		for (let k = 0; k < 3; k++) this.#tableFloats[w + k] = entry.base[k] - this.#origin[k];
	}

	#setFactors(entry: Entry, factors: number): void {
		let mask = 0;
		for (let q = 0; q < 4; q++) if ((factors >>> (8 * q)) & 255) mask |= 1 << q;
		if (mask !== entry.mask) {
			entry.mask = mask;
			const hidden = this.#hidden;
			if (mask === 15 && this.#table[entry.table * PAGE_WORDS + 3] > 0) {
				entry.active = entry.slots.some((slot) => hidden[slot])
					? entry.slots.filter((slot) => !hidden[slot])
					: entry.slots;
			} else {
				const active: number[] = [];
				const page = entry.table * PAGE_WORDS;
				let first = 0;
				let last = -1;
				for (let q = 0; q < 4; q++) {
					const end = this.#table[page + (q === 3 ? 3 : 7 + 4 * q)];
					if (mask & (1 << q) && end > first) {
						for (
							let c = Math.max(last + 1, Math.floor(first / CLUSTER));
							c < Math.ceil(end / CLUSTER);
							c++
						) {
							if (!hidden[entry.slots[c]]) active.push(entry.slots[c]);
							last = c;
						}
					}
					first = end;
				}
				entry.active = active;
			}
		}
		entry.factors = factors;
		const word = entry.table * PAGE_WORDS + FACTORS;
		this.#table[word] = factors;
		this.#tableDirty.mark(word, word + 1);
	}

	/** the masks over each cluster of an uploaded entry; its active clusters follow on its next draw */
	#relate(entry: Entry): void {
		const floats = this.#clusterFloats;
		const min = [0, 0, 0];
		const max = [0, 0, 0];
		for (const slot of entry.slots) {
			const w = slot * CLUSTER_WORDS;
			for (let k = 0; k < 3; k++) {
				min[k] = entry.base[k] + floats[w + 4 + k];
				max[k] = entry.base[k] + floats[w + 8 + k];
			}
			const crossing: number[] = [];
			const hidden = this.masks.relate(entry.layer, min, max, crossing) ? 1 : 0;
			const was = this.#masked[slot];
			if (hidden !== this.#hidden[slot]) entry.mask = -1;
			this.#hidden[slot] = hidden;
			if (was.length || crossing.length) this.#maskedChanged = true;
			this.#masked[slot] = crossing.length ? crossing : NONE;
		}
	}

	/** every cluster's list into the masks' buffer, and its place into the cluster table */
	#flushMasks(): void {
		this.#maskedChanged = false;
		const words = this.#clusterWords;
		const lists: number[] = [];
		let at = this.masks.listBase;
		for (let slot = 0; slot < this.#masked.length; slot++) {
			const masked = this.#masked[slot];
			const w = slot * CLUSTER_WORDS;
			const place = masked.length ? at : 0;
			if (words[w + MASK_LIST] !== place || words[w + MASK_COUNT] !== masked.length) {
				words[w + MASK_LIST] = place;
				words[w + MASK_COUNT] = masked.length;
				this.#clusterDirty.mark(w, w + CLUSTER_WORDS);
			}
			for (const id of masked) lists.push(id);
			at += masked.length;
		}
		this.masks.write(lists);
	}

	/** need free slots: one run when the pool has one, else the lowest free ones */
	#take(need: number): number[] {
		const taken = this.#taken;
		let at = -1;
		for (let start = this.#firstFree; start <= taken.length - need;) {
			let end = start;
			while (end < start + need && !taken[end]) end++;
			if (end === start + need) {
				at = start;
				break;
			}
			start = taken.indexOf(0, end + 1);
			if (start < 0) break;
		}
		const out: number[] = [];
		if (at >= 0) for (let s = at; s < at + need; s++) out.push(s);
		else for (let s = this.#firstFree; out.length < need; s = taken.indexOf(0, s + 1)) out.push(s);
		for (const s of out) taken[s] = 1;
		const next = taken.indexOf(0, this.#firstFree);
		this.#firstFree = next < 0 ? taken.length : next;
		this.#free -= need;
		return out;
	}
}
