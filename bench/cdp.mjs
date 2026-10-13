// chrome over the devtools protocol: launch or reuse, page sessions, evaluate
/** @import { ChildProcess } from 'node:child_process' */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/opt/google/chrome/google-chrome';
// as the workstation's desktop chrome runs: wayland, gl compositing; headful, since headless webgpu
// gets no real adapter
const FLAGS = [
	'--ozone-platform=wayland',
	'--enable-features=VaapiVideoDecodeLinuxGL',
	'--disable-features=UseChromeOSDirectVideoDecoder',
	// unquantised timestamp queries
	'--enable-webgpu-developer-features',
	'--force-device-scale-factor=1',
	'--no-first-run',
	'--no-default-browser-check'
];
// a private headless wayland display, so no desktop window covers, throttles or shows the bench
const CAGE = {
	WLR_BACKENDS: 'headless',
	WLR_LIBINPUT_NO_DEVICES: '1',
	WLR_RENDERER: 'vulkan'
};

/** @param {number} port */
const devtools = (port) => `http://127.0.0.1:${port}`;

/** @param {number} port */
export const listening = (port) =>
	fetch(`${devtools(port)}/json/version`).then(
		(r) => r.ok,
		() => false
	);

/** @type {(what: string, ms: number, test: () => Promise<boolean>) => Promise<void>} */
export const until = async (what, ms, test) => {
	const end = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(50);
	}
};

/** @type {(what: string, ms: number, promise: Promise<any>) => Promise<any>} */
export const within = async (what, ms, promise) => {
	const timeout = sleep(ms, undefined, { ref: false }).then(() => {
		throw new Error(`timed out waiting for ${what}`);
	});
	return Promise.race([promise, timeout]);
};

// the display's WIDTHxHEIGHT@RATEHz, which the kiosk window fills
const MODE = '1920x1080@100Hz';

// null when a browser answers on port already; the profile and chrome.log go in dir
/** @type {(port: number, dir: string, extra: string[]) => Promise<ChildProcess | null>} */
export const launch = async (port, dir, extra) => {
	if (await listening(port)) return null;
	const log = join(dir, 'chrome.log');
	// the mode is set before chrome starts, so its window opens at the display size
	const args = [
		'-d',
		'--',
		'sh',
		'-c',
		'wlr-randr --output HEADLESS-1 --custom-mode "$0" && exec "$@"',
		MODE,
		CHROME,
		`--remote-debugging-port=${port}`,
		'--remote-debugging-address=127.0.0.1',
		`--user-data-dir=${join(dir, 'chrome')}`,
		...FLAGS,
		...extra,
		'about:blank'
	];
	// detached, so a reused chrome outlives this process; cage ends with it
	const chrome = spawn('cage', args, {
		detached: true,
		stdio: ['ignore', 'ignore', openSync(log, 'w')],
		env: { ...process.env, ...CAGE }
	});
	chrome.unref();
	/** @type {string | undefined} */
	let exited;
	chrome.once('exit', (code, signal) => {
		exited = `chrome exited (${code ?? signal}), see ${log}`;
	});
	await until('devtools', 20_000, async () => {
		if (exited) throw new Error(exited);
		return listening(port);
	});
	return chrome;
};

// a session on a devtools websocket; a crashed page fails every pending call
/** @param {string} url */
export async function connect(url) {
	const ws = new WebSocket(url);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = () => reject(new Error(`devtools connection to ${url} failed`));
	});
	let id = 0;
	/** @type {Map<number, { method: string } & PromiseWithResolvers<any>>} */
	const pending = new Map();
	/** @type {Map<string, ((params: any) => void)[]>} */
	const listeners = new Map();
	/** @param {Error} error */
	const fail = (error) => {
		for (const call of pending.values()) call.reject(error);
		pending.clear();
	};
	ws.onmessage = ({ data }) => {
		const { id: key, result, error, method, params } = JSON.parse(data);
		// a killed renderer leaves the socket open, so an awaited call would wait forever
		if (method === 'Inspector.targetCrashed') fail(new Error('page crashed'));
		for (const fn of listeners.get(method) ?? []) fn(params);
		const call = pending.get(key);
		if (!call) return;
		pending.delete(key);
		if (error) call.reject(new Error(`${call.method}: ${error.message}`));
		else call.resolve(result);
	};
	ws.onclose = () => fail(new Error('devtools closed'));

	/** @type {(method: string, params?: object) => Promise<any>} */
	const send = (method, params = {}) => {
		const call = { method, ...Promise.withResolvers() };
		pending.set(++id, call);
		ws.send(JSON.stringify({ id, method, params }));
		return call.promise;
	};
	/** @type {(method: string, fn: (params: any) => void) => void} */
	const on = (method, fn) => {
		listeners.set(method, [...(listeners.get(method) ?? []), fn]);
	};
	/** @param {string} expression */
	const evaluate = async (expression) => {
		const { result, exceptionDetails } = await send('Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true
		});
		if (exceptionDetails)
			throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
		return result.value;
	};
	return { send, on, evaluate, close: () => ws.close() };
}

/** @typedef {Awaited<ReturnType<typeof connect>>} Session */

// the first page of the browser on port, with crashes reported
/** @param {number} port */
export async function attach(port) {
	/** @type {{ type: string, webSocketDebuggerUrl: string }[]} */
	const targets = await fetch(`${devtools(port)}/json/list`).then((r) => r.json());
	const target = targets.find((t) => t.type === 'page');
	if (!target) throw new Error(`no page in the browser on port ${port}`);
	const page = await connect(target.webSocketDebuggerUrl);
	await page.send('Inspector.enable');
	return page;
}

/** @param {{ value?: unknown, description?: string }} arg */
const describe = (arg) => arg.description ?? String(arg.value);

// page console calls and uncaught exceptions as fn(type, text)
/** @type {(page: Session, fn: (type: string, text: string) => void) => Promise<void>} */
export const onConsole = async (page, fn) => {
	page.on('Runtime.consoleAPICalled', ({ type, args }) => fn(type, args.map(describe).join(' ')));
	page.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
		fn('exception', exceptionDetails.exception?.description ?? exceptionDetails.text)
	);
	await page.send('Runtime.enable');
};

// closes the browser on port; false when none answers
/** @param {number} port */
export async function stop(port) {
	if (!(await listening(port))) return false;
	const version = await fetch(`${devtools(port)}/json/version`).then((r) => r.json());
	const browser = await connect(version.webSocketDebuggerUrl);
	// the socket may close before the reply
	await browser.send('Browser.close').catch(() => {});
	await until('chrome to close', 10_000, async () => !(await listening(port)));
	return true;
}
