// <narcissus-viewer>: a world in a page with one tag; importing this module defines it

import { Controls, defaultView, opening, parsePose } from '../controls/index.ts';
import { createEngine, type Engine, type Settings, type World } from '../engine/index.ts';

const VIEW_DISTANCE = 4000;
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

/**
 * attributes: src, the url of a world.json; budget, the splats a frame may draw; view-distance in
 * metres; camera, the pose to open on as E,N,H,yaw,pitch,dist; sky as r,g,b from 0 to 1. camera
 * and sky are read when a world opens and when the element starts.
 * events: ready, with the World as its detail, and error, with a message.
 * after an error, such as a browser without webgpu, its own content shows in place of the canvas,
 * or the message when it has none.
 */
export class NarcissusViewer extends HTMLElement {
	static observedAttributes = ['src', 'budget', 'view-distance'];

	#canvas: HTMLCanvasElement;
	#fallback: HTMLSlotElement;
	#message: HTMLElement;
	#engine: Engine | null = null;
	#controls: Controls | null = null;
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

	/** the camera controls while a world is open */
	get controls(): Controls | null {
		return this.#controls;
	}

	connectedCallback(): void {
		void this.#start();
	}

	disconnectedCallback(): void {
		this.#stop();
	}

	attributeChangedCallback(name: string): void {
		if (!this.#engine) return;
		if (name === 'src') void this.#open(this.#engine);
		else this.#engine.configure(this.#settings());
	}

	#settings(): Settings {
		const number = (name: string, otherwise: number) => {
			const value = Number(this.getAttribute(name));
			return value > 0 && Number.isFinite(value) ? value : otherwise;
		};
		return {
			budget: number('budget', mobile() ? 2_000_000 : 4_000_000),
			viewDistance: number('view-distance', VIEW_DISTANCE)
		};
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
			engine.onLost((why) => this.#fail(`The graphics device stopped (${why}).`));
			this.#resized.observe(this);
			this.#fit();
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
			world = await engine.open(src);
		} catch (error) {
			if (turn !== this.#turn) return;
			const why = error instanceof Error ? error.message : String(error);
			return this.#fail(`Could not load the world (${why}).`);
		}
		if (turn !== this.#turn) return;
		const ground = (e: number, n: number) => engine.ground(e, n) ?? world.extent.h[0];
		const pose = parsePose(this.getAttribute('camera') ?? '') ?? {
			...opening(world),
			...defaultView
		};
		this.#controls?.destroy();
		this.#controls = new Controls(this.#canvas, engine, ground, pose);
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
