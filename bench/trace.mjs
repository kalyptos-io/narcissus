// chrome's own account of frames: which reached the display, and its gpu process's main thread
import { connect } from './cdp.mjs';

/** @typedef {{ name: string, cat: string, ph: string, ts: number, dur?: number, pid: number, tid: number, id2?: { local: string }, args?: any }} TraceEvent */

// PipelineReporter is in benchmark, task spans in toplevel, performance.mark() in blink.user_timing
const CATEGORIES = ['benchmark', 'toplevel', 'blink.user_timing', '__metadata'];
const SHOWN = new Set(['STATE_PRESENTED_ALL', 'STATE_PRESENTED_PARTIAL']);

/** starts a browser-wide trace on the chrome at port; stop() returns its events */
export async function trace(/** @type {number} */ port) {
	const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
	const browser = await connect(version.webSocketDebuggerUrl);
	await browser.send('Tracing.start', {
		transferMode: 'ReturnAsStream',
		traceConfig: { recordMode: 'recordUntilFull', includedCategories: CATEGORIES }
	});
	return {
		async stop() {
			/** @type {Promise<{ stream: string }>} */
			const complete = new Promise((resolve) => browser.on('Tracing.tracingComplete', resolve));
			await browser.send('Tracing.end');
			const { stream } = await complete;
			const parts = [];
			for (;;) {
				const { data, base64Encoded, eof } = await browser.send('IO.read', {
					handle: stream,
					size: 1 << 24
				});
				parts.push(base64Encoded ? Buffer.from(data, 'base64').toString() : data);
				if (eof) break;
			}
			await browser.send('IO.close', { handle: stream });
			browser.close();
			return /** @type {TraceEvent[]} */ (JSON.parse(parts.join('')).traceEvents);
		}
	};
}

/**
 * frames of the page that set performance marks `${name}:start` and `${name}:end`, between them:
 * shown per second, the wait for the first shown frame and the longest wait, dropped, and the share of the
 * time the gpu process's main thread was busy, which every tab's drawing queues behind
 * @param {TraceEvent[]} events
 * @param {string} name
 */
export function shown(events, name) {
	const mark = (/** @type {string} */ which) =>
		events.find((e) => e.name === `${name}:${which}` && e.cat.includes('blink.user_timing'));
	const [first, last] = [mark('start'), mark('end')];
	if (!first || !last) throw new Error(`no ${name} marks in the trace`);
	const [from, to] = [first.ts, last.ts];
	const page = first.pid;
	const gpuMain = new Set(
		events
			.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrGpuMain')
			.map((e) => `${e.pid}:${e.tid}`)
	);
	/** @type {Map<string, string>} */
	const opened = new Map();
	/** @type {number[]} */
	const times = [];
	let dropped = 0;
	let busy = 0;
	for (const e of events) {
		if (e.name === 'PipelineReporter' && e.pid === page && e.id2) {
			const key = e.id2.local;
			if (e.ph === 'b') opened.set(key, e.args?.frame_reporter?.state);
			if (e.ph !== 'e' || !opened.has(key)) continue;
			const state = opened.get(key);
			opened.delete(key);
			if (e.ts < from || e.ts > to) continue;
			if (SHOWN.has(state ?? '')) times.push(e.ts);
			else if (state === 'STATE_DROPPED') dropped++;
		} else if (
			e.ph === 'X' &&
			e.name === 'ThreadControllerImpl::RunTask' &&
			gpuMain.has(`${e.pid}:${e.tid}`)
		) {
			busy += Math.max(0, Math.min(e.ts + (e.dur ?? 0), to) - Math.max(e.ts, from));
		}
	}
	times.sort((x, y) => x - y);
	const points = [from, ...times];
	const waits = points.slice(1).map((t, i) => t - points[i]);
	return {
		fps: times.length / ((to - from) / 1e6),
		firstMs: ((times[0] ?? to) - from) / 1000,
		maxGapMs: Math.max(0, ...waits) / 1000,
		dropped,
		gpuMainShare: busy / (to - from)
	};
}
