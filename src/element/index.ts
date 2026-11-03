// <narcissus-viewer>: a world in a page with one tag; importing this module defines it

import { Controls, defaultView, opening, parsePose } from '../controls/index.ts';
import { createEngine, type Engine, type Settings, type World } from '../engine/index.ts';

const VIEW_DISTANCE = 4000;
const BUDGET = 4_000_000;
const BUDGET_RANGE = [2_000_000, 6_000_000] as const;
const PHONE_BUDGET = 2_000_000;
const SKY = [0.62, 0.72, 0.8] as const;

const template = document.createElement('template');
// the canvas is out of flow: in flow its pixel size would set the height it is then fitted to
template.innerHTML = `<style>
:host { display: block; position: relative; box-sizing: border-box; width: 100%; aspect-ratio: 16 / 9; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
[hidden] { display: none; }
</style><canvas></canvas><slot hidden></slot><p part="message" hidden></p>`;

function mobile(): boolean {
	const nav = navigator as Navigator & { userAgentData?: { mobile: boolean } };
	return nav.userAgentData?.mobile ?? /Mobi|Android/i.test(nav.userAgent);
}

export interface NarcissusViewerEventMap extends Omit<HTMLElementEventMap, 'error'> {
	start: Event;
	ready: CustomEvent<World>;
	error: CustomEvent<string>;
}

/**
 * attributes: src, the url of a world.json; budget, the splats a frame may draw, which otherwise
 * adapts to the frame rate; view-distance in metres; camera, the pose to open on as
 * E,N,H,yaw,pitch,dist, its focus on the ground there when H is left empty, as the opening view's;
 * sky as r,g,b from 0 to 1. camera and sky are read when a world opens and when the element starts.
 * aria-label names the canvas too, which takes focus for the camera's keys.
 * properties: objects, read when a world opens, as engine.open() takes it.
 * events: start once the engine and the controls are made, ready with the World as its detail each
 * time a world opens, and error with a message. the engine and the controls, and all a page adds to
 * them, live from start until the element leaves the page, through every change of src.
 * after an error, such as a browser without webgpu, its own content shows in place of the canvas,
 * or the message when it has none.
 */
export class NarcissusViewer extends HTMLElement {
	static observedAttributes = ['src', 'budget', 'view-distance', 'aria-label'];

	/** the url of each unit's .ids by its pack path, for each world it opens; see engine.open() */
	objects: Readonly<Record<string, string>> = {};

	#canvas: HTMLCanvasElement;
	#fallback: HTMLSlotElement;
	#message: HTMLElement;
	#engine: Engine | null = null;
	#controls: Controls | null = null;
	#world: World | null = null;
	#resized = new ResizeObserver(() => this.#fit());
	/** counts starts, stops and opens, so one that finishes late knows it is stale */
	#turn = 0;

	constructor() {
		super();
		const root = this.attachShadow({ mode: 'open' });
		root.append(template.content.cloneNode(true));
		this.#canvas = root.querySelector('canvas')!;
		this.#fallback = root.querySelector('slot')!;
		this.#message = root.querySelector('p')!;
	}

	/** the engine while it runs, for plugins and for a camera of the page's own */
	get engine(): Engine | null {
		return this.#engine;
	}

	/** the camera controls while the engine runs */
	get controls(): Controls | null {
		return this.#controls;
	}

	connectedCallback(): void {
		void this.#start();
	}

	disconnectedCallback(): void {
		this.#stop();
	}

	addEventListener<K extends keyof NarcissusViewerEventMap>(
		type: K,
		listener: (this: NarcissusViewer, event: NarcissusViewerEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	): void {
		super.addEventListener(type, listener, options);
	}

	removeEventListener<K extends keyof NarcissusViewerEventMap>(
		type: K,
		listener: (this: NarcissusViewer, event: NarcissusViewerEventMap[K]) => unknown,
		options?: boolean | EventListenerOptions
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions
	): void {
		super.removeEventListener(type, listener, options);
	}

	attributeChangedCallback(name: string, _: string | null, value: string | null): void {
		if (name === 'aria-label') {
			if (value === null) this.#canvas.removeAttribute('aria-label');
			else this.#canvas.setAttribute('aria-label', value);
			return;
		}
		if (!this.#engine) return;
		if (name === 'src') void this.#open(this.#engine);
		else this.#engine.configure(this.#settings());
	}

	#settings(): Settings {
		const number = (name: string) => {
			const value = Number(this.getAttribute(name));
			return value > 0 && Number.isFinite(value) ? value : null;
		};
		const budget = number('budget');
		const viewDistance = number('view-distance') ?? VIEW_DISTANCE;
		if (budget !== null) return { budget, viewDistance };
		if (mobile()) return { budget: PHONE_BUDGET, viewDistance };
		return { budget: BUDGET, budgetRange: BUDGET_RANGE, viewDistance };
	}

	async #start(): Promise<void> {
		const turn = ++this.#turn;
		this.#canvas.hidden = false;
		this.#fallback.hidden = this.#message.hidden = true;
		const sky = this.getAttribute('sky')?.split(',').map(Number);
		try {
			const engine = await createEngine(this.#canvas, {
				settings: this.#settings(),
				sky: sky?.length === 3 && sky.every(Number.isFinite) ? [sky[0], sky[1], sky[2]] : SKY
			});
			if (turn !== this.#turn) return engine.destroy();
			this.#engine = engine;
			this.#controls = new Controls(this.#canvas, engine, {
				ground: (e, n) => engine.ground(e, n) ?? this.#world?.extent.h[0] ?? 0,
				// until the first world opens
				pose: { e: 0, n: 0, h: 0, ...defaultView }
			});
			engine.onLost((why) => this.#fail(`The graphics device stopped (${why}).`));
			this.#resized.observe(this);
			this.#fit();
			this.dispatchEvent(new Event('start'));
			// a start listener may have taken the element off the page
			if (turn !== this.#turn) return;
			await this.#open(engine);
		} catch (error) {
			if (turn === this.#turn) this.#fail(error instanceof Error ? error.message : String(error));
		}
	}

	async #open(engine: Engine): Promise<void> {
		const src = this.getAttribute('src');
		if (!src) return;
		const turn = ++this.#turn;
		let world: World;
		try {
			world = await engine.open(src, { objects: this.objects });
		} catch (error) {
			if (turn !== this.#turn) return;
			const why = error instanceof Error ? error.message : String(error);
			return this.#fail(`Could not load the world (${why}).`);
		}
		if (turn !== this.#turn) return;
		this.#world = world;
		const parts = (this.getAttribute('camera') ?? '').split(',');
		const grounded = parts.length === 6 && parts[2].trim() === '';
		const asked = parsePose((grounded ? parts.with(2, '0') : parts).join(','));
		const [e, n, h] = opening(world);
		const pose = asked ?? { e, n, h, ...defaultView };
		if (grounded || !asked) {
			// just after open the ground is the roots' coarse pages', often far below the real one
			const h = await engine.groundAt(pose.e, pose.n).catch(() => undefined);
			if (turn !== this.#turn) return;
			pose.h = h ?? world.extent.h[0];
		}
		this.#controls!.jump(pose);
		this.dispatchEvent(new CustomEvent('ready', { detail: world }));
	}

	#fit(): void {
		this.#engine?.resize(this.clientWidth, this.clientHeight, devicePixelRatio);
	}

	#stop(): void {
		this.#turn++;
		this.#resized.disconnect();
		this.#controls?.destroy();
		this.#controls = null;
		this.#engine?.destroy();
		this.#engine = null;
		this.#world = null;
	}

	#fail(message: string): void {
		this.#stop();
		this.#canvas.hidden = true;
		// white space between the tags is content to a slot, so its own fallback text would not show
		const own = this.#fallback
			.assignedNodes()
			.some((node) => node instanceof Element || node.textContent?.trim());
		this.#fallback.hidden = !own;
		this.#message.hidden = own;
		this.#message.textContent = message;
		this.dispatchEvent(new CustomEvent('error', { detail: message }));
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'narcissus-viewer': NarcissusViewer;
	}
}

// a page may load the module twice, from a bundle and from a script tag
if (!customElements.get('narcissus-viewer')) {
	customElements.define('narcissus-viewer', NarcissusViewer);
}
