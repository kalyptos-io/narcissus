// which page ranges to fetch next: priority order, siblings merged, stale fetches aborted

export interface PageJob {
	id: number;
	/** world.json-relative paths */
	pack: string;
	col: string | null;
	offset: number;
	length: number;
}

/** one range request covering pages of one pack */
export interface Batch {
	pack: string;
	col: string | null;
	start: number;
	end: number;
	/** the span-aligned stretch of the pack its pages start in; one worker owns each */
	window: number;
	pages: PageJob[];
}

export interface SchedulerOptions {
	/** batches in flight */
	concurrency: number;
	/** bytes two pages may lie apart and still share a request */
	gap: number;
	/** bytes one request may span, and the stretches of a pack batches stay inside */
	span: number;
}

export class Scheduler {
	#options: SchedulerOptions;
	#wanted: PageJob[] = [];
	#ids = new Set<number>();
	#batches = new Set<Batch>();
	#aborting = new Set<Batch>();
	/** the batch of every page in flight */
	#flying = new Map<number, Batch>();

	constructor(options: SchedulerOptions) {
		this.#options = options;
	}

	/** the wanted pages, most wanted first; replaces the last call's */
	want(jobs: PageJob[]): void {
		this.#wanted = jobs;
		this.#ids = new Set(jobs.map((job) => job.id));
	}

	/** batches to start now, and batches in flight none of whose pages is wanted any more */
	next(): { start: Batch[]; abort: Batch[] } {
		const abort: Batch[] = [];
		for (const batch of this.#batches) {
			if (this.#aborting.has(batch)) continue;
			if (batch.pages.some((page) => this.#ids.has(page.id))) continue;
			this.#aborting.add(batch);
			abort.push(batch);
		}
		const start: Batch[] = [];
		if (this.#batches.size >= this.#options.concurrency) return { start, abort };
		const packs = new Map<string, PageJob[]>();
		for (const job of this.#wanted) {
			if (this.#flying.has(job.id)) continue;
			const jobs = packs.get(job.pack);
			if (jobs) jobs.push(job);
			else packs.set(job.pack, [job]);
		}
		for (const jobs of packs.values()) jobs.sort((a, b) => a.offset - b.offset);
		for (const job of this.#wanted) {
			if (this.#batches.size >= this.#options.concurrency) break;
			if (this.#flying.has(job.id)) continue;
			const batch = this.#merge(job, packs.get(job.pack)!);
			for (const page of batch.pages) this.#flying.set(page.id, batch);
			this.#batches.add(batch);
			start.push(batch);
		}
		return { start, abort };
	}

	/** a batch finished, failed or was aborted */
	done(batch: Batch): void {
		if (!this.#batches.delete(batch)) return;
		this.#aborting.delete(batch);
		for (const page of batch.pages) {
			if (this.#flying.get(page.id) === batch) this.#flying.delete(page.id);
		}
	}

	/** wanted pages not in flight */
	get queued(): number {
		let queued = 0;
		for (const id of this.#ids) if (!this.#flying.has(id)) queued++;
		return queued;
	}

	/** pages in flight */
	get loading(): number {
		return this.#flying.size;
	}

	/** seed plus the free pages around it in its pack's offset order */
	#merge(seed: PageJob, jobs: PageJob[]): Batch {
		const { gap, span } = this.#options;
		const window = Math.floor(seed.offset / span);
		const at = jobs.indexOf(seed);
		const pages = [seed];
		let start = seed.offset;
		let end = seed.offset + seed.length;
		for (let k = at + 1; k < jobs.length; k++) {
			const job = jobs[k];
			if (this.#flying.has(job.id)) continue;
			const after = Math.max(end, job.offset + job.length);
			if (job.offset - end > gap || after - start > span) break;
			if (Math.floor(job.offset / span) !== window) break;
			pages.push(job);
			end = after;
		}
		for (let k = at - 1; k >= 0; k--) {
			const job = jobs[k];
			if (this.#flying.has(job.id)) continue;
			if (start - (job.offset + job.length) > gap || end - job.offset > span) break;
			if (Math.floor(job.offset / span) !== window) break;
			pages.unshift(job);
			start = job.offset;
		}
		return { pack: seed.pack, col: seed.col, start, end, window, pages };
	}
}
