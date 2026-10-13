// a plan turned into residency: idx fetches, page batches, pool admission and tree pruning

import { unitPath } from '../../format/idx.ts';
import type { Pool } from '../gpu/pool.ts';
import type { Plan } from '../plan/cut.ts';
import type { Tree, UnitNode } from '../world/tree.ts';
import { isMissing } from '../../adapters/http.ts';
import type { Loader } from './loader.ts';
import { Scheduler, type Batch, type PageJob } from './scheduler.ts';
import type { Loaded } from './worker.ts';

export interface FeedOptions {
	/** .idx fetches in flight */
	idx: number;
	/** page batches in flight */
	concurrency: number;
	/** bytes two pages may lie apart and still share a request */
	gap: number;
	/** bytes one request may span */
	span: number;
}

// few small batches: they split the link, a batch's pages wait for all its bytes, each page for its parent
export const FEED: FeedOptions = { idx: 8, concurrency: 8, gap: 64 * 1024, span: 2 * 1024 * 1024 };

/** ms a failed path waits, doubling per failure up to RETRY_MAX */
const RETRY = 1000;
const RETRY_MAX = 30_000;
/** ms a page the pool refused waits */
const REFUSED = 1000;
/** ms between prune checks */
const PRUNE = 2000;

export class Feed {
	#tree: Tree;
	#loader: Loader;
	#pool: Pool;
	#onArrive: () => void;
	/** runs once, when an immutable file answered 404: the world was released anew and must be reopened */
	#onStale: () => void;
	#options: FeedOptions;
	#scheduler: Scheduler;
	#plan: Plan = { cut: [], load: [], idx: [], keep: new Set(), planned: 0, missing: 0 };
	#drawn: ReadonlySet<number> = new Set();
	/** the jobs last handed to the scheduler */
	#wanted: PageJob[] = [];
	/** the last update's time; failures and refusals wait from it */
	#now = 0;
	#idx = new Set<string>();
	#batches = new Map<Batch, AbortController>();
	/** by pack or idx path */
	#retry = new Map<string, { delay: number; until: number }>();
	/** page id to the time it may load again */
	#refused = new Map<number, number>();
	/** by pack or idx path, or page id: a replan for when its wait ends */
	#timers = new Map<string | number, ReturnType<typeof setTimeout>>();
	/** ids the pool accepted; it may have evicted some since */
	#held = new Set<number>();
	/** units added and the update that first saw them; prune spares them for PRUNE ms */
	#added = new Map<UnitNode, number>();
	/** units added since the last update */
	#arrived: UnitNode[] = [];
	#pruned = -Infinity;
	#stale = false;
	#destroyed = false;

	/** onArrive runs when an idx or page arrives or a batch ends, so the engine plans and draws again */
	constructor(
		tree: Tree,
		loader: Loader,
		pool: Pool,
		onArrive: () => void,
		onStale: () => void,
		options: FeedOptions = FEED
	) {
		this.#tree = tree;
		this.#loader = loader;
		this.#pool = pool;
		this.#onArrive = onArrive;
		this.#onStale = onStale;
		this.#options = options;
		const { concurrency, gap, span } = options;
		this.#scheduler = new Scheduler({ concurrency, gap, span });
	}

	/**
	 * takes the latest plan: fetches its idx and load lists, aborts what left them, and admits
	 * arriving pages into the pool while protecting plan.keep and drawn
	 */
	update(plan: Plan, drawn: ReadonlySet<number>, now: number): void {
		if (this.#destroyed) return;
		this.#plan = plan;
		this.#drawn = drawn;
		this.#now = now;
		for (const unit of this.#arrived) this.#added.set(unit, now);
		this.#arrived = [];
		this.#fetchIdx();
		this.#wanted = this.#jobs();
		this.#scheduler.want(this.#wanted);
		this.#advance();
		this.#prune();
	}

	/** idx fetches and page batches in flight */
	get loading(): number {
		return this.#idx.size + this.#batches.size;
	}

	/** pages wanted and not yet started */
	get queued(): number {
		return this.#scheduler.queued;
	}

	/** nothing wanted, in flight or waiting to upload */
	get idle(): boolean {
		if (this.#idx.size > 0 || this.#batches.size > 0 || this.#pool.queued > 0) return false;
		const { idx, load } = this.#plan;
		return idx.length === 0 && load.every(({ id }) => this.#pool.holds(id));
	}

	destroy(): void {
		this.#destroyed = true;
		for (const controller of this.#batches.values()) controller.abort();
		this.#batches.clear();
		this.#idx.clear();
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}

	#fetchIdx(): void {
		if (this.#stale) return;
		for (const { path } of this.#plan.idx) {
			if (this.#idx.size >= this.#options.idx) break;
			if (this.#idx.has(path) || this.#waiting(path)) continue;
			this.#idx.add(path);
			void this.#loader.idx(path).then(
				(idx) => {
					if (this.#destroyed) return;
					this.#idx.delete(path);
					this.#succeed(path);
					this.#arrived.push(this.#tree.add(idx, path));
					this.#onArrive();
				},
				(error: unknown) => {
					if (this.#destroyed) return;
					this.#idx.delete(path);
					this.#fail(path, error);
				}
			);
		}
	}

	/** the plan's load pages not held and not waiting, most wanted first */
	#jobs(): PageJob[] {
		const jobs: PageJob[] = [];
		for (const { id, unit, row } of this.#plan.load) {
			const { idx } = unit;
			const pack = unitPath(unit, idx.pack, 'pack');
			if (!this.#ready(id, pack)) continue;
			const col = idx.col ? unitPath(unit, idx.col, 'col') : null;
			jobs.push({ id, pack, col, offset: row.offset, length: row.length });
		}
		return jobs;
	}

	#advance(): void {
		if (this.#stale) return;
		const { start, abort } = this.#scheduler.next();
		for (const batch of abort) this.#batches.get(batch)?.abort();
		for (const batch of start) {
			const controller = new AbortController();
			this.#batches.set(batch, controller);
			void this.#loader.batch(batch, controller.signal, this.#arrive).then(
				() => this.#done(batch),
				(error: unknown) => this.#failed(batch, error)
			);
		}
	}

	/** a page of a batch in flight, into the pool */
	#arrive = ({ id, page }: Loaded): void => {
		if (this.#destroyed) return;
		const node = this.#tree.pages.get(id);
		if (!node) return;
		const { keep } = this.#plan;
		const drawn = this.#drawn;
		const protect = (id: number) => keep.has(id) || drawn.has(id);
		if (this.#pool.add(id, page, [node.unit.e, node.unit.n], protect)) {
			this.#held.add(id);
			if (this.#refused.delete(id)) this.#unwake(id);
		} else {
			this.#refused.set(id, this.#now + REFUSED);
			this.#wake(id, REFUSED);
		}
		this.#onArrive();
	};

	#done(batch: Batch): void {
		if (this.#destroyed) return;
		this.#batches.delete(batch);
		this.#succeed(batch.pack);
		// want before done: done frees the batch's pages, and those still wanted would start again
		this.#wanted = this.#wanted.filter((job) => this.#ready(job.id, job.pack));
		this.#scheduler.want(this.#wanted);
		this.#scheduler.done(batch);
		this.#advance();
		this.#onArrive();
	}

	#failed(batch: Batch, error: unknown): void {
		if (this.#destroyed) return;
		this.#batches.delete(batch);
		this.#scheduler.done(batch);
		if (!(error instanceof DOMException && error.name === 'AbortError')) {
			this.#fail(batch.pack, error);
		}
	}

	#fail(path: string, error: unknown): void {
		if (isMissing(error)) {
			if (this.#stale) return;
			this.#stale = true;
			this.#onStale();
			return;
		}
		const last = this.#retry.get(path);
		const delay = last ? Math.min(2 * last.delay, RETRY_MAX) : RETRY;
		this.#retry.set(path, { delay, until: this.#now + delay });
		this.#wake(path, delay);
	}

	#succeed(path: string): void {
		this.#retry.delete(path);
		this.#unwake(path);
	}

	/** onArrive once key's wait ends, so the engine replans with nothing else moving */
	#wake(key: string | number, delay: number): void {
		clearTimeout(this.#timers.get(key));
		const timer = setTimeout(() => {
			this.#timers.delete(key);
			this.#onArrive();
		}, delay);
		this.#timers.set(key, timer);
	}

	#unwake(key: string | number): void {
		clearTimeout(this.#timers.get(key));
		this.#timers.delete(key);
	}

	#prune(): void {
		const now = this.#now;
		if (now - this.#pruned < PRUNE) return;
		this.#pruned = now;
		for (const id of this.#held) if (!this.#pool.holds(id)) this.#held.delete(id);
		for (const [id, until] of this.#refused) if (until <= now) this.#refused.delete(id);
		for (const [unit, seen] of this.#added) if (now - seen >= PRUNE) this.#added.delete(unit);
		const { keep } = this.#plan;
		if (this.#tree.pages.size <= 2 * (this.#held.size + keep.size)) return;
		const kept = new Set([...keep, ...this.#drawn, ...this.#held]);
		// a fresh unit's pages wait on a plan that refines into them
		for (const unit of this.#added.keys()) for (const { id } of unit.pages) kept.add(id);
		for (const id of this.#tree.prune(kept)) if (this.#pool.holds(id)) this.#pool.remove(id);
	}

	#ready(id: number, pack: string): boolean {
		if (!this.#tree.pages.has(id) || this.#pool.holds(id)) return false;
		return !this.#refusing(id) && !this.#waiting(pack);
	}

	#refusing(id: number): boolean {
		const until = this.#refused.get(id);
		return until !== undefined && this.#now < until;
	}

	/** a failed pack or idx path still backing off */
	#waiting(path: string): boolean {
		const retry = this.#retry.get(path);
		return retry !== undefined && this.#now < retry.until;
	}
}
