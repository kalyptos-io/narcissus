import { describe, expect, it } from 'vitest';
import { Scheduler, type PageJob } from './scheduler.ts';

const KiB = 1024;

function job(id: number, offset: number, length = 10 * KiB, pack = 'a.pack'): PageJob {
	return { id, pack, col: null, offset, length };
}

function scheduler(concurrency = 24) {
	return new Scheduler({ concurrency, gap: 64 * KiB, span: 8 * 1024 * KiB });
}

const ids = (batches: { pages: PageJob[] }[]) => batches.map((b) => b.pages.map((p) => p.id));

describe('Scheduler', () => {
	it('merges adjacent siblings of one pack into one range request', () => {
		const s = scheduler();
		s.want([job(2, 10 * KiB), job(1, 0), job(4, 30 * KiB), job(3, 20 * KiB)]);
		const { start } = s.next();
		expect(ids(start)).toEqual([[1, 2, 3, 4]]);
		expect(start[0].start).toBe(0);
		expect(start[0].end).toBe(40 * KiB);
		expect(start[0].pack).toBe('a.pack');
	});

	it('keeps pages of other packs and pages past the gap apart', () => {
		const s = scheduler();
		s.want([job(1, 0), job(2, 10 * KiB, 10 * KiB, 'b.pack'), job(3, 200 * KiB)]);
		expect(ids(s.next().start)).toEqual([[1], [2], [3]]);
	});

	it('merges across a gap of unwanted bytes up to the gap', () => {
		const s = scheduler();
		s.want([job(1, 0), job(2, 74 * KiB)]);
		expect(ids(s.next().start)).toEqual([[1, 2]]);
	});

	it('splits a run longer than the span', () => {
		const s = new Scheduler({ concurrency: 24, gap: 64 * KiB, span: 25 * KiB });
		s.want([job(1, 0), job(2, 10 * KiB), job(3, 20 * KiB)]);
		const { start } = s.next();
		expect(ids(start)).toEqual([[1, 2], [3]]);
		expect(start.every((b) => b.end - b.start <= 25 * KiB)).toBe(true);
	});

	it('keeps the pages of each span-aligned window apart', () => {
		const s = new Scheduler({ concurrency: 24, gap: 64 * KiB, span: 25 * KiB });
		s.want([job(1, 10 * KiB), job(2, 20 * KiB), job(3, 30 * KiB)]);
		const { start } = s.next();
		expect(ids(start)).toEqual([[1, 2], [3]]);
		expect(start.map((b) => b.window)).toEqual([0, 1]);
	});

	it('starts batches in priority order up to the concurrency', () => {
		const s = scheduler(2);
		s.want([job(1, 0), job(2, 1000 * KiB), job(3, 2000 * KiB)]);
		const first = s.next();
		expect(ids(first.start)).toEqual([[1], [2]]);
		expect(s.next().start).toEqual([]);
		expect(s.loading).toBe(2);
		expect(s.queued).toBe(1);
		s.done(first.start[0]);
		s.want([job(2, 1000 * KiB), job(3, 2000 * KiB)]);
		expect(ids(s.next().start)).toEqual([[3]]);
		expect(s.queued).toBe(0);
	});

	it('never starts a page in flight again', () => {
		const s = scheduler();
		s.want([job(1, 0)]);
		const { start } = s.next();
		s.want([job(1, 0), job(2, 10 * KiB)]);
		expect(ids(s.next().start)).toEqual([[2]]);
		s.want([job(2, 10 * KiB), job(1, 0)]);
		expect(s.next()).toEqual({ start: [], abort: [] });
		s.done(start[0]);
		expect(s.loading).toBe(1);
	});

	it('returns a batch to abort once none of its pages is wanted, and only once', () => {
		const s = scheduler(1);
		s.want([job(1, 0), job(2, 10 * KiB)]);
		const [batch] = s.next().start;
		s.want([job(2, 10 * KiB), job(3, 1000 * KiB)]);
		expect(s.next().abort).toEqual([]);
		s.want([job(3, 1000 * KiB)]);
		const stale = s.next();
		expect(stale.abort).toEqual([batch]);
		expect(stale.start).toEqual([]);
		expect(s.next().abort).toEqual([]);
		s.done(batch);
		expect(ids(s.next().start)).toEqual([[3]]);
	});
});
