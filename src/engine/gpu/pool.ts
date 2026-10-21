// resident pages on the gpu: records in CLUSTER-splat slots, the page and cluster tables, the cut mask

import {
	CLUSTER,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PARAMS,
	type DecodedPage
} from '../../format/index.ts';
import { CLUSTER_WORDS, PAGE_WORDS, slots } from './layout.ts';
import type { Drawn } from '../types.ts';

/** u32 words of the cut mask a cluster slot takes, a bit a record */
const MASK_WORDS = CLUSTER / 32;
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
	/** the slots with a drawn record */
	active: number[];
	/** page-table slot */
	table: number;
	/** page origin in world metres */
	base: [number, number, number];
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
	/** a bit per record: drawn in the cut */
	cut!: GPUBuffer;
	// cull input: the clusters with a drawn record
	list!: GPUBuffer;
	listed = 0;
	/** splats */
	capacity: number;

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
	#mask: Uint32Array<ArrayBuffer>;
	#maskDirty = new Dirty();
	#list: Uint32Array<ArrayBuffer>;
	/** the entries with a drawn record, in the order they began to draw */
	#drawing = new Set<Entry>();
	#listDirty = false;
	/** ids of uploaded pages removed since the last gone() */
	#gone: number[] = [];

	constructor(device: GPUDevice, capacity: number) {
		this.capacity = capacity;
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
		this.#mask = new Uint32Array(slots * MASK_WORDS);
		this.#list = new Uint32Array(slots);
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

	/** pages with a drawn record */
	get drawn(): number {
		return this.#drawing.size;
	}

	/** ids of uploaded pages removed since the last call */
	gone(): number[] {
		return this.#gone.splice(0);
	}

	/**
	 * queues page id of the unit with south-west corner (e, n), evicting the least recently kept
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
		const entry: Entry = {
			id,
			previous: null,
			next: null,
			page,
			slots: this.#take(need),
			active: [],
			table: this.#tables.pop()!,
			base: [page.params[o] + unit[0], page.params[o + 1] + unit[1], page.params[o + 2]]
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
		for (const slot of entry.slots) this.#taken[slot] = 0;
		this.#firstFree = Math.min(this.#firstFree, entry.slots[0]);
		this.#free += entry.slots.length;
		this.#tables.push(entry.table);
		if (entry.page !== null) return;
		this.#gone.push(id);
		// the gpu list may name its clusters until the next draw
		this.#setMask(entry, null);
	}

	clear(): void {
		for (const id of this.#entries.keys()) this.remove(id);
	}

	/** pages queued and not yet uploaded */
	get queued(): number {
		return this.#queue.size;
	}

	/** writes queued pages until about maxBytes went up, each to uploaded; returns the bytes written */
	upload(maxBytes: number, uploaded?: (id: number, page: DecodedPage) => void): number {
		let written = 0;
		for (const id of this.#queue) {
			if (written >= maxBytes) break;
			const entry = this.#entries.get(id)!;
			const page = entry.page!;
			written += this.#write(entry);
			this.#queue.delete(id);
			uploaded?.(id, page);
		}
		return written;
	}

	/** the cut masks that changed, and every change since the last draw onto the gpu */
	draw(changes: readonly Drawn[]): void {
		for (const { id, mask } of changes) {
			const entry = this.#entries.get(id);
			if (entry && entry.page === null) this.#setMask(entry, mask);
		}
		const queue = this.#device.queue;
		this.#tableDirty.flush(queue, this.pages, this.#table);
		this.#clusterDirty.flush(queue, this.clusters, this.#clusterWords);
		this.#maskDirty.flush(queue, this.cut, this.#mask);
		if (!this.#listDirty) return;
		this.#listDirty = false;
		let listed = 0;
		for (const entry of this.#drawing) {
			this.#list.set(entry.active, listed);
			listed += entry.active.length;
		}
		this.listed = listed;
		if (listed) queue.writeBuffer(this.list, 0, this.#list, 0, listed);
	}

	/** marks ids as just used, so the least recently kept pages go first */
	keep(ids: Iterable<number>): void {
		for (const id of ids) {
			const entry = this.#entries.get(id);
			if (entry) this.#touch(entry);
		}
	}

	/** world position of the floating origin; rewrites every page origin */
	setOrigin(origin: readonly [number, number, number]): void {
		this.#origin = [origin[0], origin[1], origin[2]];
		for (const entry of this.#entries.values()) if (entry.page === null) this.#place(entry);
		this.#device.queue.writeBuffer(this.pages, 0, this.#table);
		this.#tableDirty.clear();
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
		const mask = new Uint32Array(slots * MASK_WORDS);
		mask.set(this.#mask);
		this.#mask = mask;
		const list = new Uint32Array(slots);
		list.set(this.#list);
		this.#list = list;
	}

	destroy(): void {
		for (const b of this.#buffers()) b.destroy();
	}

	#buffers(): GPUBuffer[] {
		return [this.geometry, this.colour, this.pages, this.clusters, this.cut, this.list];
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
		this.cut = make('pool cut', slots * MASK_WORDS * 4);
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

	/** frees the least recently kept uploaded pages keep rejects until need slots are free */
	#fit(need: number, keep: (id: number) => boolean): boolean {
		let free = this.#free;
		if (free >= need) return true;
		const evict: number[] = [];
		for (let entry = this.#oldest; entry; entry = entry.next) {
			if (entry.page !== null || keep(entry.id)) continue;
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
		table.fill(0, w, w + PAGE_WORDS);
		this.#place(entry);
		table[w + 3] = page.count;
		f.set(p.subarray(PARAMS.step, PARAMS.step + 3), w + 4);
		f.set(p.subarray(PARAMS.scaleMin, PARAMS.scaleMin + 3), w + 8);
		f.set(p.subarray(PARAMS.scaleMax, PARAMS.scaleMax + 3), w + 12);
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

	/** the page's cut mask, a bit a record from its first; null or empty for none drawn */
	#setMask(entry: Entry, mask: Uint32Array | null): void {
		const words = this.#mask;
		const active: number[] = [];
		for (let c = 0; c < entry.slots.length; c++) {
			const at = entry.slots[c] * MASK_WORDS;
			let any = 0;
			for (let k = 0; k < MASK_WORDS; k++) {
				const bits = mask?.[c * MASK_WORDS + k] ?? 0;
				words[at + k] = bits;
				any |= bits;
			}
			if (any) active.push(entry.slots[c]);
			this.#maskDirty.mark(at, at + MASK_WORDS);
		}
		const was = entry.active.length > 0;
		entry.active = active;
		if (active.length) this.#drawing.add(entry);
		else this.#drawing.delete(entry);
		this.#listDirty ||= was || active.length > 0;
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
