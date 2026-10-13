import { describe, expect, it } from 'vitest';
import {
	C0,
	C1,
	CLUSTER,
	COLOUR_WORDS,
	FRAME_UNIFORM_BYTES,
	GEOMETRY_WORDS,
	KEY_BITS,
	LOW_PASS,
	PAGE_PARAMS,
	PARAMS,
	PLUGIN_VEC4S,
	PROJECTED_WORDS,
	WORK
} from '../format/spec.ts';
import { planes } from '../math/frustum.ts';
import { multiply, perspective, transform, view } from '../math/mat4.ts';
import type { Shade } from '../ports.ts';
import type { DecodedPage } from '../types.ts';
import { frameBuffers } from './buffers.ts';
import { Pool } from './pool.ts';
import { Project } from './project.ts';
import { readBuffer, testDevice } from './test-device.ts';

const WIDTH = 1920;
const HEIGHT = 1080;
const NEAR = 0.5;
const FAR = 300;
const EYE: [number, number, number] = [0, 0, 1.5];
const CAPACITY = 1024;
const QUADRANTS: [number, number, number] = [2, 4, 6];
// quadrant 1 at half, the others full
const FACTORS = (255 | (128 << 8) | (255 << 16) | (255 << 24)) >>> 0;
const FADE = 'fn fade(s: ptr<function, Splat>, u: array<vec4f, 1>) { (*s).opacity *= u[0].x; }';

/** a splat's codes as the pool record holds them */
interface Raw {
	q: [number, number, number];
	alpha: number;
	/** index of the largest component, then the other three */
	rotation: [number, number, number, number];
	scale: [number, number, number];
	dc: [number, number, number];
	/** i8, sh[c][m] at 3c + m */
	sh: number[];
}

// the camera looks north from EYE: four splats ahead, one behind, one far east, one just off screen
const SPLATS: Raw[] = [
	{
		q: [30000, 15000, 3000],
		alpha: 230,
		rotation: [0, 140, 120, 135],
		scale: [230, 130, 40],
		dc: [200, 120, 60],
		sh: [100, -50, 20, -127, 60, 0, 30, -90, 127]
	},
	{
		q: [31000, 22500, 4000],
		alpha: 180,
		rotation: [1, 128, 150, 110],
		scale: [220, 140, 60],
		dc: [90, 210, 140],
		sh: [-30, 80, -100, 40, -20, 110, -60, 10, 50]
	},
	{
		q: [28500, 35000, 2500],
		alpha: 255,
		rotation: [2, 115, 128, 145],
		scale: [235, 120, 50],
		dc: [140, 140, 230],
		sh: [60, 60, -60, -60, 90, -90, 0, 127, -127]
	},
	{
		q: [30500, 50000, 5500],
		alpha: 200,
		rotation: [3, 135, 125, 120],
		scale: [240, 150, 30],
		dc: [20, 60, 250],
		sh: [10, -10, 70, -70, 30, -30, 100, -100, 5]
	},
	{
		q: [30000, 5000, 3000],
		alpha: 255,
		rotation: [0, 128, 128, 128],
		scale: [200, 200, 200],
		dc: [128, 128, 128],
		sh: [0, 0, 0, 0, 0, 0, 0, 0, 0]
	},
	{
		q: [50000, 15000, 3000],
		alpha: 255,
		rotation: [0, 128, 128, 128],
		scale: [200, 200, 200],
		dc: [128, 128, 128],
		sh: [0, 0, 0, 0, 0, 0, 0, 0, 0]
	},
	{
		q: [36150, 15000, 3000],
		alpha: 255,
		rotation: [0, 128, 128, 128],
		scale: [0, 0, 0],
		dc: [128, 128, 128],
		sh: [0, 0, 0, 0, 0, 0, 0, 0, 0]
	}
];

const PAGE = new Float32Array(PAGE_PARAMS);
PAGE.set([-60, -20, -5], PARAMS.origin);
PAGE.set([0.002, 0.002, 0.002], PARAMS.step);
PAGE.set([-4, -4, -4], PARAMS.scaleMin);
PAGE.set([0, 0, 0], PARAMS.scaleMax);
PAGE.set([-1.5, -1.5, -1.5], PARAMS.dcMin);
PAGE.set([1.5, 1.5, 1.5], PARAMS.dcMax);
PAGE.set([0.3, 0.32, 0.34, 0.36, 0.38, 0.4, 0.42, 0.44, 0.46], PARAMS.shScale);

function page(): DecodedPage {
	const geometry = new Uint32Array(SPLATS.length * GEOMETRY_WORDS);
	const colour = new Uint32Array(SPLATS.length * COLOUR_WORDS);
	SPLATS.forEach((s, t) => {
		const [index, a, b, c] = s.rotation;
		const sh = s.sh.map((v) => v & 255);
		const g = [
			s.q[0] | (s.q[1] << 16),
			s.q[2] | (s.alpha << 16) | (index << 24),
			a | (b << 8) | (c << 16) | (s.scale[0] << 24),
			s.scale[1] | (s.scale[2] << 8)
		];
		const k = [
			s.dc[0] | (s.dc[1] << 8) | (s.dc[2] << 16) | (sh[0] << 24),
			sh[1] | (sh[2] << 8) | (sh[3] << 16) | (sh[4] << 24),
			sh[5] | (sh[6] << 8) | (sh[7] << 16) | (sh[8] << 24)
		];
		geometry.set(g, t * GEOMETRY_WORDS);
		colour.set(k, t * COLOUR_WORDS);
	});
	return {
		count: SPLATS.length,
		quadrants: QUADRANTS,
		geometry,
		colour,
		params: PAGE,
		clusters: new Float32Array(6)
	};
}

/** FrameUniforms for the camera at EYE looking north */
function frame(device: GPUDevice, buffer: GPUBuffer): Float32Array {
	const data = new ArrayBuffer(FRAME_UNIFORM_BYTES);
	const f = new Float32Array(data);
	const v = view(new Float32Array(16), EYE, 0, 0);
	const p = perspective(new Float32Array(16), Math.PI / 3, WIDTH / HEIGHT, NEAR, FAR);
	f.set(v, 0);
	f.set(p, 16);
	multiply(f.subarray(32, 48), p, v);
	planes(f.subarray(48, 72), f.subarray(32, 48));
	f.set(EYE, 72);
	f.set([WIDTH, HEIGHT, (p[0] * WIDTH) / 2, (p[5] * HEIGHT) / 2, NEAR, FAR, LOW_PASS], 76);
	device.queue.writeBuffer(buffer, 0, data);
	return f;
}

interface Expected {
	centre: number[];
	major: number[];
	minor: number[];
	colour: number[];
	opacity: number;
	depth: number;
	key: number;
}

/** a byte over [lo, hi] */
function decode(lo: number, hi: number, byte: number): number {
	return lo + (byte / 255) * (hi - lo);
}

function sum3(f: (k: number) => number): number {
	return f(0) + f(1) + f(2);
}

function mat(f: (i: number, j: number) => number): number[][] {
	return [0, 1, 2].map((i) => [0, 1, 2].map((j) => f(i, j)));
}

/** splat t on the cpu in float64, null where it cannot show */
function expected(t: number, u: Float32Array): Expected | null {
	const s = SPLATS[t];
	const at = (k: number, n: number) => [...PAGE.subarray(k, k + n)];
	const [origin, step] = [at(PARAMS.origin, 3), at(PARAMS.step, 3)];
	const coordinate = (k: number) => origin[k] + s.q[k] * step[k];
	const position: [number, number, number] = [coordinate(0), coordinate(1), coordinate(2)];
	const v = u.subarray(0, 16);
	const [x, y, z] = transform(v, position);
	const depth = -z;
	if (depth < NEAR || depth > FAR) return null;
	const clip = transform(u.subarray(16, 32), [x, y, z]);
	const ndc = [clip[0] / clip[3], clip[1] / clip[3]];
	if (Math.abs(ndc[0]) > 1.3 || Math.abs(ndc[1]) > 1.3) return null;

	// covariance
	const [index, ...codes] = s.rotation;
	const rest = codes.map((b) => (b / 255 - 0.5) * Math.SQRT2);
	const big = Math.sqrt(Math.max(0, 1 - rest.reduce((a, r) => a + r * r, 0)));
	const quaternion = [...rest];
	quaternion.splice(index, 0, big);
	const length = Math.hypot(...quaternion);
	const [w, qx, qy, qz] = quaternion.map((c) => c / length);
	const r = [
		[1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - w * qz), 2 * (qx * qz + w * qy)],
		[2 * (qx * qy + w * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - w * qx)],
		[2 * (qx * qz - w * qy), 2 * (qy * qz + w * qx), 1 - 2 * (qx * qx + qy * qy)]
	];
	const [scaleMin, scaleMax] = [at(PARAMS.scaleMin, 3), at(PARAMS.scaleMax, 3)];
	const scale = s.scale.map((b, k) => Math.exp(decode(scaleMin[k], scaleMax[k], b)));
	const sigma = mat((i, j) => sum3((k) => r[i][k] * scale[k] * scale[k] * r[j][k]));
	const wr = mat((i, j) => v[j * 4 + i]);
	const cov = mat((i, j) => sum3((a) => sum3((b) => wr[i][a] * sigma[a][b] * wr[j][b])));
	const [fx, fy] = [u[78], u[79]];
	const j0 = [fx / depth, 0, (fx * x) / (depth * depth)];
	const j1 = [0, fy / depth, (fy * y) / (depth * depth)];
	const form = (l: number[], m: number[]) => sum3((a) => sum3((b) => l[a] * cov[a][b] * m[b]));
	const a = form(j0, j0) + u[82];
	const b = form(j0, j1);
	const c = form(j1, j1) + u[82];
	const mid = (a + c) / 2;
	const rad = Math.hypot((a - c) / 2, b);
	const angle = Math.atan2(2 * b, a - c) / 2;
	const [major, minor] = [Math.sqrt(mid + rad), Math.sqrt(Math.max(mid - rad, 0))];
	const quadrant = QUADRANTS.filter((q) => t >= q).length;
	const opacity = (s.alpha / 255) * (((FACTORS >>> (8 * quadrant)) & 255) / 255);
	const centre = [(ndc[0] * 0.5 + 0.5) * WIDTH, (ndc[1] * 0.5 + 0.5) * HEIGHT];
	const reach = Math.min(3, Math.sqrt(Math.max(2 * Math.log(255 * opacity), 0)));
	const [cos, sin] = [Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle))];
	const extent = [reach * (cos * major + sin * minor), reach * (sin * major + cos * minor)];
	const size = [WIDTH, HEIGHT];
	if ([0, 1].some((k) => centre[k] + extent[k] < 0 || centre[k] - extent[k] > size[k])) return null;

	// colour
	const dcMin = at(PARAMS.dcMin, 3);
	const dcMax = at(PARAMS.dcMax, 3);
	const shScale = at(PARAMS.shScale, 9);
	const toward = position.map((p, k) => p - EYE[k]);
	const d = toward.map((p) => p / Math.hypot(...toward));
	const sh = (k: number) => (s.sh[k] / 127) * shScale[k];
	const colour = [0, 1, 2].map((k) => {
		const dc = decode(dcMin[k], dcMax[k], s.dc[k]);
		const lean = -d[1] * sh(3 * k) + d[2] * sh(3 * k + 1) - d[0] * sh(3 * k + 2);
		return Math.max(0, 0.5 + C0 * dc + C1 * lean);
	});

	const span = Math.min(1, Math.max(0, Math.log(depth / NEAR) / Math.log(FAR / NEAR)));
	return {
		centre,
		major: [Math.cos(angle) * major, Math.sin(angle) * major],
		minor: [-Math.sin(angle) * minor, Math.cos(angle) * minor],
		colour,
		opacity,
		depth,
		key: Math.trunc((1 - span) * ((1 << KEY_BITS) - 1))
	};
}

function half(bits: number): number {
	const exponent = (bits >> 10) & 31;
	const scale = exponent ? 2 ** (exponent - 15) : 2 ** -14;
	const magnitude = scale * ((exponent ? 1 : 0) + (bits & 1023) / 1024);
	return bits & 0x8000 ? -magnitude : magnitude;
}

const unpack = (word: number) => [half(word & 0xffff), half(word >>> 16)];

const gap = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function expectClose(got: number[], want: number[], tolerance: number): void {
	got.forEach((value, k) => {
		const allowed = tolerance * Math.max(1, Math.abs(want[k]));
		expect(Math.abs(value - want[k])).toBeLessThanOrEqual(allowed);
	});
}

async function setup() {
	const device = await testDevice();
	const pool = new Pool(device, 4 * CLUSTER);
	pool.add(1, page(), [0, 0], () => false);
	pool.upload(Infinity);
	pool.draw([{ id: 1, factors: FACTORS }]);
	const buffers = frameBuffers(device, CAPACITY, pool.slots);
	const uniforms = frame(device, buffers.uniforms);
	return { device, pool, buffers, uniforms, project: new Project(device, pool, buffers) };
}

/** the drawn clusters as the visible list, then the projection alone */
async function run({ device, pool, buffers, project }: Awaited<ReturnType<typeof setup>>) {
	const header = new Uint32Array(WORK.list);
	header[WORK.visible] = pool.listed;
	device.queue.writeBuffer(buffers.work, 0, header);
	const encoder = device.createCommandEncoder();
	encoder.copyBufferToBuffer(pool.list, 0, buffers.work, WORK.list * 4, pool.listed * 4);
	project.encode(encoder);
	device.queue.submit([encoder.finish()]);
	const work = new Uint32Array(await readBuffer(device, buffers.work, 0, WORK.list * 4));
	const projected = await readBuffer(device, buffers.projected);
	const sort = new Uint32Array(await readBuffer(device, buffers.sort));
	return { count: work[WORK.projected], projected, sort };
}

describe('Project', () => {
	it('projects splats as the cpu does and drops those behind or outside', async () => {
		const context = await setup();
		const { count, projected, sort } = await run(context);
		const want = SPLATS.map((_, t) => expected(t, context.uniforms)).filter((e) => e !== null);
		expect(want).toHaveLength(4);
		expect(count).toBe(4);

		const floats = new Float32Array(projected);
		const words = new Uint32Array(projected);
		const matched: Expected[] = [];
		for (let i = 0; i < count; i++) {
			const w = i * PROJECTED_WORDS;
			const centre = [floats[w], floats[w + 1]];
			const e = want.find((x) => gap(x.centre, centre) < 1);
			if (!e) throw new Error(`no splat projects to ${centre}`);
			matched.push(e);
			expectClose(centre, e.centre, 1e-4);
			// an axis is a direction up to sign
			const axes = [unpack(words[w + 2]), unpack(words[w + 3])];
			[e.major, e.minor].forEach((axis, k) => {
				const sign = axes[k][0] * axis[0] + axes[k][1] * axis[1] < 0 ? -1 : 1;
				expectClose(
					axes[k].map((g) => g * sign),
					axis,
					2e-3
				);
			});
			const colour = [...unpack(words[w + 4]), ...unpack(words[w + 5])];
			expectClose(colour, [...e.colour, e.opacity], 2e-3);
			expect(Math.abs(sort[i] - e.key)).toBeLessThanOrEqual(64);
			expect(sort[CAPACITY + i]).toBe(i);
		}
		expect(new Set(matched).size).toBe(4);

		const ascending = matched.map((_, i) => i).sort((a, b) => sort[a] - sort[b]);
		const depths = ascending.map((i) => matched[i].depth);
		expect(depths).toEqual([...depths].sort((a, b) => b - a));

		context.pool.destroy();
		context.buffers.destroy();
	});

	it('culls every splat when a shade hook zeroes the opacity', async () => {
		const context = await setup();
		const fade: Shade = { name: 'fade', uniforms: 1, wgsl: FADE, update() {} };
		context.project.hooks([{ shade: fade, slot: 3 }]);
		const values = new Float32Array(PLUGIN_VEC4S * 4).fill(1);
		values[3 * 4] = 0;
		context.device.queue.writeBuffer(context.buffers.plugins, 0, values);
		expect((await run(context)).count).toBe(0);
		values[3 * 4] = 1;
		context.device.queue.writeBuffer(context.buffers.plugins, 0, values);
		expect((await run(context)).count).toBe(4);
		context.pool.destroy();
		context.buffers.destroy();
	});
});
