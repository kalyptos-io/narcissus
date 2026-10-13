import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unitPath, LEAF, type DecodedPage, type Idx, type UnitKey } from '../../format/index.ts';
import type { Pool } from '../gpu/pool.ts';
import type { Plan } from '../plan/cut.ts';
import { hash, unit as full } from '../world/test-tree.ts';
import { Tree, unitKey, type PageNode, type Wanted } from '../world/tree.ts';
import { FEED, Feed, type FeedOptions } from './feed.ts';
import { httpError } from '../../adapters/http.ts';
import type { Loader } from './loader.ts';
import type { Batch } from './scheduler.ts';

const E = 720000;
const N = 6176000;
const ROOT = { level: 1, e: E, n: N };
const SIZE = 1000;
const NONE = new Set<number>();

type Loaded = { id: number; page: DecodedPage }[];

interface Pending<T> {
	resolve(value: T): void;
	reject(error: unknown): void;
}

class FakeLoader {
	idxs: (Pending<Idx> & { path: string })[] = [];
	batches: (Pending<Loaded> & { batch: Batch; signal: AbortSignal })[] = [];

	idx(path: string): Promise<Idx> {
		return new Promise((resolve, reject) => this.idxs.push({ path, resolve, reject }));
	}

	/** resolve hands the pages over one by one, then settles */
	batch(batch: Batch, signal: AbortSignal, page: (loaded: Loaded[number]) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			const pages = (loaded: Loaded) => {
				loaded.forEach(page);
				resolve();
			};
			this.batches.push({ batch, signal, resolve: pages, reject });
		});
	}
}

/** holds up to capacity pages, evicting the oldest ones keep rejects */
class FakePool {
	/** id to the unit corner it came with */
	held = new Map<number, readonly [number, number]>();
	queued = 0;
	#capacity: number;

	constructor(capacity: number) {
		this.#capacity = capacity;
	}

	holds(id: number): boolean {
		return this.held.has(id);
	}

	has(id: number): boolean {
		return this.held.has(id);
	}

	add(
		id: number,
		_page: DecodedPage,
		unit: readonly [number, number],
		keep: (id: number) => boolean
	): boolean {
		if (this.held.has(id)) return true;
		for (const other of this.held.keys()) {
			if (this.held.size < this.#capacity) break;
			if (!keep(other)) this.held.delete(other);
		}
		if (this.held.size >= this.#capacity) return false;
		this.held.set(id, unit);
		return true;
	}

	remove(id: number): void {
		this.held.delete(id);
	}
}

/** a full unit whose pages lie back to back in its pack */
const unit = (key: UnitKey) => full(key, { count: 100, size: SIZE });

function decoded(): DecodedPage {
	return {
		count: 100,
		quadrants: [25, 50, 75],
		geometry: new Uint32Array(0),
		colour: new Uint32Array(0),
		params: new Float32Array(0),
		clusters: new Float32Array(0)
	};
}

const loaded = (pages: PageNode[]): Loaded => pages.map(({ id }) => ({ id, page: decoded() }));
const ids = (pages: { id: number }[]) => pages.map(({ id }) => id);
const settle = () => vi.advanceTimersByTimeAsync(0);

function plan(load: PageNode[], idx: Wanted[] = [], keep: PageNode[] = load): Plan {
	return { cut: load, load, idx, keep: new Set(ids(keep)), planned: 0, missing: 0 };
}

/** a tree holding one level-1 root, its four children wanted */
function setup(options: Partial<FeedOptions> = {}, capacity = Infinity) {
	const tree = new Tree({
		version: 1,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: LEAF,
		roots: [{ ...ROOT, idx: 'root.idx' }],
		extent: { e: [E, E + 500], n: [N, N + 500], h: [0, 5] },
		extra: {}
	});
	const root = tree.add(unit(ROOT), 'root.idx');
	const loader = new FakeLoader();
	const pool = new FakePool(capacity);
	const arrive = vi.fn();
	const stale = vi.fn();
	const typed = { loader: loader as unknown as Loader, pool: pool as unknown as Pool };
	const feed = new Feed(tree, typed.loader, typed.pool, arrive, stale, { ...FEED, ...options });
	return { tree, root, loader, pool, arrive, stale, feed };
}

describe('Feed', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fetches each wanted idx once, up to the limit, and adds it to the tree', async () => {
		const { tree, loader, arrive, feed } = setup({ idx: 2 });
		const wanted = tree.wanted();
		const paths = wanted.map(({ path }) => path);
		feed.update(plan([], wanted), NONE, 0);
		feed.update(plan([], wanted), NONE, 10);
		expect(loader.idxs.map(({ path }) => path)).toEqual(paths.slice(0, 2));
		expect(feed.loading).toBe(2);

		loader.idxs[0].resolve(unit(wanted[0]));
		await settle();
		expect(tree.units.has(unitKey(wanted[0]))).toBe(true);
		expect(arrive).toHaveBeenCalledTimes(1);
		expect(feed.loading).toBe(1);

		feed.update(plan([], tree.wanted()), NONE, 20);
		expect(loader.idxs.map(({ path }) => path)).toEqual(paths.slice(0, 3));
	});

	it('batches the pages of a plan and admits them into the pool', async () => {
		const { root, loader, pool, arrive, feed } = setup();
		const pages = root.pages.slice(0, 3);
		feed.update(plan(pages), NONE, 0);
		expect(loader.batches).toHaveLength(1);
		const [{ batch }] = loader.batches;
		expect(batch.pack).toBe(unitPath(ROOT, hash(ROOT), 'pack'));
		expect(batch.col).toBeNull();
		expect(ids(batch.pages)).toEqual(ids(pages));
		expect(feed.idle).toBe(false);

		loader.batches[0].resolve(loaded(pages));
		await settle();
		expect(pages.every(({ id }) => pool.holds(id))).toBe(true);
		expect(pool.held.get(pages[2].id)).toEqual([E, N]);
		// each page, then the batch's end
		expect(arrive).toHaveBeenCalledTimes(pages.length + 1);
		expect(feed.loading).toBe(0);

		feed.update(plan(pages), NONE, 10);
		expect(loader.batches).toHaveLength(1);
		expect(feed.idle).toBe(true);
	});

	it('aborts a batch whose pages left the plan', async () => {
		const { root, loader, feed } = setup();
		const [a, b] = root.pages;
		feed.update(plan([a]), NONE, 0);
		feed.update(plan([b]), NONE, 10);
		const [first, second] = loader.batches;
		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(ids(second.batch.pages)).toEqual([b.id]);
		await settle();
		expect(feed.loading).toBe(1);
	});

	it('drops a page whose unit was pruned before it arrived', async () => {
		const { tree, loader, pool, arrive, feed } = setup();
		const [wanted] = tree.wanted();
		const child = tree.add(unit(wanted), wanted.path);
		const [page] = child.pages;
		feed.update(plan([page]), NONE, 0);
		expect(tree.prune(NONE)).toEqual(ids(child.pages));

		loader.batches[0].resolve(loaded([page]));
		await settle();
		expect(pool.held.size).toBe(0);
		expect(feed.loading).toBe(0);
		expect(arrive).toHaveBeenCalledTimes(1);
	});

	it('backs a failing pack off, doubling the wait, and resets it on success', async () => {
		const { root, loader, pool, feed } = setup();
		const [a, b] = root.pages;
		const fail = async (k: number) => {
			loader.batches[k].reject(new Error('http 503 for u/1/x.pack'));
			await settle();
		};
		feed.update(plan([a]), NONE, 0);
		await fail(0);
		feed.update(plan([a]), NONE, 999);
		expect(loader.batches).toHaveLength(1);
		expect(feed.idle).toBe(false);
		feed.update(plan([a]), NONE, 1000);
		expect(loader.batches).toHaveLength(2);

		await fail(1);
		feed.update(plan([a]), NONE, 2999);
		expect(loader.batches).toHaveLength(2);
		feed.update(plan([a]), NONE, 3000);
		expect(loader.batches).toHaveLength(3);
		loader.batches[2].resolve(loaded([a]));
		await settle();
		expect(pool.holds(a.id)).toBe(true);

		feed.update(plan([b]), NONE, 3000);
		await fail(3);
		feed.update(plan([b]), NONE, 4000);
		expect(loader.batches).toHaveLength(5);
	});

	it('backs a failing idx path off', async () => {
		const { tree, loader, feed } = setup();
		const [wanted] = tree.wanted();
		feed.update(plan([], [wanted]), NONE, 0);
		loader.idxs[0].reject(new Error('a stream worker failed'));
		await settle();
		expect(feed.loading).toBe(0);
		feed.update(plan([], [wanted]), NONE, 999);
		expect(loader.idxs).toHaveLength(1);
		feed.update(plan([], [wanted]), NONE, 1000);
		expect(loader.idxs.map(({ path }) => path)).toEqual([wanted.path, wanted.path]);
	});

	it('calls onStale once when immutable files answer 404', async () => {
		const { tree, loader, stale, feed } = setup();
		feed.update(plan([], tree.wanted()), NONE, 0);
		for (const call of loader.idxs) call.reject(httpError(404, call.path));
		await settle();
		expect(loader.idxs).toHaveLength(4);
		expect(stale).toHaveBeenCalledTimes(1);
	});

	it('starts no fetch once the world went stale', async () => {
		const { tree, root, loader, feed } = setup();
		const [first, ...rest] = tree.wanted();
		feed.update(plan([], [first]), NONE, 0);
		loader.idxs[0].reject(httpError(404, first.path));
		await settle();
		feed.update(plan(root.pages.slice(0, 2), rest), NONE, 10);
		expect(loader.idxs).toHaveLength(1);
		expect(loader.batches).toHaveLength(0);
		expect(feed.queued).toBe(2);
	});

	it('replans when a backoff ends, until destroy cancels the wait', async () => {
		const { root, loader, arrive, feed } = setup();
		const [a] = root.pages;
		feed.update(plan([a]), NONE, 0);
		loader.batches[0].reject(new Error('http 503 for u/1/x.pack'));
		await vi.advanceTimersByTimeAsync(999);
		expect(arrive).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(arrive).toHaveBeenCalledTimes(1);

		feed.update(plan([a]), NONE, 1000);
		loader.batches[1].reject(new Error('http 503 for u/1/x.pack'));
		await settle();
		feed.destroy();
		await vi.advanceTimersByTimeAsync(2000);
		expect(arrive).toHaveBeenCalledTimes(1);
	});

	it('replans when a refusal ends and is not idle before', async () => {
		const { root, loader, arrive, feed } = setup({}, 1);
		const [a, b] = root.pages;
		feed.update(plan([a, b], [], []), new Set([a.id]), 0);
		loader.batches[0].resolve(loaded([a, b]));
		await vi.advanceTimersByTimeAsync(999);
		expect(arrive).toHaveBeenCalledTimes(3);
		expect(feed.idle).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(arrive).toHaveBeenCalledTimes(4);
	});

	it('backs off a page the pool refuses while drawn pages fill it', async () => {
		const { root, loader, pool, feed } = setup({}, 1);
		const [a, b] = root.pages;
		const drawn = new Set([a.id]);
		const next = plan([a, b], [], []);
		feed.update(next, drawn, 0);
		expect(ids(loader.batches[0].batch.pages)).toEqual([a.id, b.id]);
		loader.batches[0].resolve(loaded([a, b]));
		await settle();
		expect(pool.holds(a.id)).toBe(true);
		expect(pool.holds(b.id)).toBe(false);
		expect(loader.batches).toHaveLength(1);

		feed.update(next, drawn, 999);
		expect(loader.batches).toHaveLength(1);
		expect(feed.idle).toBe(false);
		feed.update(next, drawn, 1000);
		expect(ids(loader.batches[1].batch.pages)).toEqual([b.id]);
	});

	it('prunes units with no held, kept or drawn page, at most every 2 s', async () => {
		const { tree, root, loader, pool, feed } = setup();
		const children = tree.wanted().map((wanted) => tree.add(unit(wanted), wanted.path));
		expect(tree.pages.size).toBe(64 + 4 * 320);
		const firsts = children.map((child) => child.pages[0]);
		feed.update(plan([firsts[0]], [], firsts), NONE, 0);
		expect(tree.units.size).toBe(5);
		loader.batches[0].resolve(loaded([firsts[0]]));
		await settle();
		// a page the pool holds that the feed never admitted
		const stray = children[3].pages[1].id;
		pool.held.set(stray, [0, 0]);

		const drawn = new Set([firsts[2].id]);
		feed.update(plan([], [], [firsts[1]]), drawn, 1000);
		expect(tree.units.size).toBe(5);
		feed.update(plan([], [], [firsts[1]]), drawn, 2000);
		expect(tree.units.size).toBe(4);
		expect(tree.units.get(unitKey(root))).toBe(root);
		for (const child of children.slice(0, 3)) {
			expect(tree.units.get(unitKey(child))).toBe(child);
		}
		expect(tree.units.has(unitKey(children[3]))).toBe(false);
		expect(tree.pages.has(firsts[3].id)).toBe(false);
		expect(pool.holds(stray)).toBe(false);
		expect(pool.holds(firsts[0].id)).toBe(true);
	});

	it('spares a unit that just arrived from the next prune', async () => {
		const { tree, loader, feed } = setup();
		const [wanted] = tree.wanted();
		feed.update(plan([], [wanted]), NONE, 0);
		loader.idxs[0].resolve(unit(wanted));
		await settle();
		feed.update(plan([]), NONE, 2000);
		expect(tree.units.has(unitKey(wanted))).toBe(true);
		feed.update(plan([]), NONE, 4000);
		expect(tree.units.has(unitKey(wanted))).toBe(false);
	});

	it('drops arrivals after destroy', async () => {
		const { tree, root, loader, pool, arrive, feed } = setup();
		const [wanted] = tree.wanted();
		const [a] = root.pages;
		feed.update(plan([a], [wanted]), NONE, 0);
		expect(feed.loading).toBe(2);
		feed.destroy();
		expect(loader.batches[0].signal.aborted).toBe(true);
		expect(feed.loading).toBe(0);

		loader.idxs[0].resolve(unit(wanted));
		loader.batches[0].resolve(loaded([a]));
		await settle();
		expect(tree.units.has(unitKey(wanted))).toBe(false);
		expect(pool.held.size).toBe(0);
		expect(arrive).not.toHaveBeenCalled();
	});
});
