import type { Engine } from '../engine/index.ts';
import {
	blend,
	cameraOf,
	clampPose,
	defaultView,
	fly,
	FOV,
	height,
	look,
	lookAt,
	pan,
	settled,
	viewOf,
	type Pose
} from './pose.ts';

/** degrees per pixel dragged */
const ROTATE = 0.2;
/** log zoom per wheel pixel */
const WHEEL = 0.002;
/** log zoom per pixel the fingers pinch */
const PINCH = 0.005;
/** fly speed in heights above the focus per second */
const FLY = 0.5;
/** seconds for the camera to close 63% of the gap to where input put it */
const TAU = 0.05;

type Ground = (e: number, n: number) => number;

/** metres one screen pixel spans at dist in a view pixels tall */
export function metresPerPixel(dist: number, pixels: number): number {
	return (2 * dist * Math.tan((FOV * Math.PI) / 360)) / Math.max(1, pixels);
}

/** right, forward and up from the held key codes */
export function flyAxes(keys: ReadonlySet<string>): [number, number, number] {
	const k = (code: string) => (keys.has(code) ? 1 : 0);
	return [
		k('KeyD') - k('KeyA') + k('ArrowRight') - k('ArrowLeft'),
		k('KeyW') - k('KeyS') + k('ArrowUp') - k('ArrowDown'),
		k('KeyE') - k('KeyQ')
	];
}

/** moves the shown pose toward the target over dt seconds; the target itself once settled */
export function smooth(shown: Pose, target: Pose, dt: number, ground: Ground): Pose {
	if (settled(shown, target)) return target;
	return clampPose(blend(shown, target, 1 - Math.exp(-dt / TAU)), ground);
}

/** map camera: left drag orbits, right/middle/shift drag pans the ground, wheel zooms, f flies */
export class Controls {
	#canvas: HTMLCanvasElement;
	#engine: Engine;
	#ground: Ground;
	#abort = new AbortController();
	/** last client position of each pointer down on the canvas */
	#pointers = new Map<number, { x: number; y: number }>();
	#keys = new Set<string>();
	#orbit: [number, number] = [0, 0];
	#pan: [number, number] = [0, 0];
	#zoom = 0;
	#flying = false;
	/** where input has put the camera; current chases it */
	#target: Pose;
	#current: Pose;
	#listeners = new Set<() => void>();
	#offFrame: () => void;
	#last: number | null = null;
	#dead = false;

	constructor(canvas: HTMLCanvasElement, engine: Engine, ground: Ground, pose: Pose) {
		this.#canvas = canvas;
		this.#engine = engine;
		this.#ground = ground;
		this.#target = clampPose(pose, this.#ground);
		this.#current = this.#target;
		this.#offFrame = engine.onFrame(this.#tick);

		const signal = this.#abort.signal;
		canvas.addEventListener('pointerdown', this.#down, { signal });
		canvas.addEventListener('pointermove', this.#move, { signal });
		for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
			canvas.addEventListener(type, this.#up, { signal });
		canvas.addEventListener('wheel', this.#wheel, { passive: false, signal });
		canvas.addEventListener('dblclick', this.#pick, { signal });
		canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
		window.addEventListener('keydown', this.#keydown, { signal });
		window.addEventListener('keyup', this.#keyup, { signal });
		// a key released while the window is in the background never sends keyup
		window.addEventListener('blur', () => this.#keys.clear(), { signal });
		this.#place();
	}

	/** the pose the camera shows now */
	get pose(): Pose {
		return { ...this.#current };
	}

	/** fires on every frame the user moves the camera */
	onChange(fn: () => void): () => void {
		this.#listeners.add(fn);
		return () => this.#listeners.delete(fn);
	}

	/** puts the focus on a ground point; heading and tilt stay, a far view closes in */
	moveTo(e: number, n: number): void {
		const t = this.#target;
		const dist = Math.min(t.dist, defaultView.dist);
		this.#target = clampPose({ ...t, e, n, h: this.#ground(e, n), dist }, this.#ground);
		this.#wake();
	}

	destroy(): void {
		this.#dead = true;
		this.#abort.abort();
		this.#offFrame();
		this.#listeners.clear();
	}

	#down = (e: PointerEvent) => {
		this.#canvas.setPointerCapture(e.pointerId);
		this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	};

	#move = (e: PointerEvent) => {
		const p = this.#pointers.get(e.pointerId);
		// a hovering pointer often presses next
		if (!p) return this.#engine.warm();
		const before = this.#pair();
		const [dx, dy] = [e.clientX - p.x, e.clientY - p.y];
		p.x = e.clientX;
		p.y = e.clientY;
		if (e.pointerType === 'mouse') {
			const left = (e.buttons & 1) !== 0;
			if ((e.buttons & 6) !== 0 || (left && e.shiftKey)) add(this.#pan, dx, dy);
			else if (left) add(this.#orbit, dx, dy);
		} else if (before) {
			const after = this.#pair()!;
			add(this.#pan, after.x - before.x, after.y - before.y);
			this.#zoom += (before.d - after.d) * PINCH;
		} else add(this.#orbit, dx, dy);
		this.#wake();
	};

	#up = (e: PointerEvent) => {
		this.#pointers.delete(e.pointerId);
	};

	#wheel = (e: WheelEvent) => {
		e.preventDefault();
		this.#zoom += e.deltaY * WHEEL;
		this.#wake();
	};

	#keydown = (e: KeyboardEvent) => {
		if (e.code === 'KeyF' && !e.repeat) this.#flying = !this.#flying;
		this.#keys.add(e.code);
		if (this.#flying) this.#wake();
	};

	#keyup = (e: KeyboardEvent) => {
		this.#keys.delete(e.code);
	};

	#pick = async (e: MouseEvent) => {
		const hit = await this.#engine.pick(e.offsetX, e.offsetY);
		if (!hit || this.#dead) return;
		const [he, hn, hh] = hit;
		this.#target = clampPose(lookAt(cameraOf(this.#current), { e: he, n: hn, h: hh }));
		this.#wake();
	};

	/** midpoint and spread of the first two pointers, or null with fewer */
	#pair() {
		if (this.#pointers.size < 2) return null;
		const [a, b] = this.#pointers.values();
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
	}

	#wake() {
		if (!this.#dead) this.#engine.requestFrame();
	}

	#tick = (time: number) => {
		// the first frame after a rest has no previous frame to measure against
		const dt = this.#last === null ? 1 / 60 : Math.min(0.1, (time - this.#last) / 1000);
		this.#last = time;
		let t = this.#target;

		const [px, py] = this.#pan;
		if (px || py) {
			const mpp = metresPerPixel(t.dist, this.#canvas.clientHeight);
			t = pan(t, -px * mpp, py * mpp);
		}
		const [ox, oy] = this.#orbit;
		if (ox || oy) {
			const [yaw, pitch] = [t.yaw + ox * ROTATE, t.pitch - oy * ROTATE];
			t = this.#flying ? look(t, yaw, pitch) : clampPose({ ...t, yaw, pitch });
		}
		if (this.#zoom) t = clampPose({ ...t, dist: t.dist * Math.exp(this.#zoom) });
		this.#pan = [0, 0];
		this.#orbit = [0, 0];
		this.#zoom = 0;

		const [x, z, y] = flyAxes(this.#keys);
		const flying = this.#flying && (x !== 0 || y !== 0 || z !== 0);
		if (flying) {
			const v = FLY * height(t) * dt;
			t = fly(t, x * v, z * v, y * v);
		}

		const was = this.#current;
		if (was !== t) {
			this.#target = t = clampPose(t, this.#ground);
			this.#current = smooth(was, t, dt, this.#ground);
			this.#place();
			for (const fn of this.#listeners) fn();
		}
		if (flying || this.#current !== this.#target) this.#wake();
		else this.#last = null;
	};

	#place() {
		this.#engine.setCamera(viewOf(this.#current));
	}
}

function add(sum: [number, number], dx: number, dy: number) {
	sum[0] += dx;
	sum[1] += dy;
}
