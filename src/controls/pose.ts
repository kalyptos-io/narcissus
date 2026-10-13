import type { Camera, World } from '../engine/index.ts';

/** easting, northing and height in world coordinates, metres */
export interface Point {
	e: number;
	n: number;
	h: number;
}

/** a camera orbiting a focus point, in world coordinates */
export interface Pose extends Point {
	/** degrees clockwise from north, the direction the camera looks */
	yaw: number;
	/** degrees, negative looks down */
	pitch: number;
	/** metres from camera to focus */
	dist: number;
}

/** vertical field of view, degrees */
export const FOV = 45;
export const defaultView = { yaw: 0, pitch: -35, dist: 300 };
/** how far a pose may go */
export interface Limits {
	/** degrees */
	pitch: readonly [number, number];
	/** metres from camera to focus */
	dist: readonly [number, number];
	/** metres the camera stays above the ground under it */
	clearance: number;
	/** the lowest height of the camera */
	floor: number;
}

export const LIMITS: Limits = { pitch: [-90, -20], dist: [1, 2_485], clearance: 10, floor: 50 };

// sine of the flattest view angle pan and fly scale for; keeps a level view moving
const FLAT = 0.1;
const RAD = Math.PI / 180;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));
const wrap = (deg: number) => ((deg % 360) + 360) % 360;
/** degrees from yaw a to yaw b the short way round */
const turn = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/** the extent's centre when a root unit covers it, else the middle of the root unit nearest it, clipped to the extent */
export function opening({ leaf, roots, extent }: Pick<World, 'leaf' | 'roots' | 'extent'>): Point {
	const centre = {
		e: (extent.e[0] + extent.e[1]) / 2,
		n: (extent.n[0] + extent.n[1]) / 2,
		h: extent.h[0]
	};
	let best = centre;
	let nearest = Infinity;
	for (const root of roots) {
		const side = leaf * 2 ** root.level;
		const [west, east] = [Math.max(root.e, extent.e[0]), Math.min(root.e + side, extent.e[1])];
		const [south, north] = [Math.max(root.n, extent.n[0]), Math.min(root.n + side, extent.n[1])];
		const gap = Math.hypot(
			Math.max(west - centre.e, 0, centre.e - east),
			Math.max(south - centre.n, 0, centre.n - north)
		);
		if (gap === 0) return centre;
		if (gap < nearest) {
			nearest = gap;
			best = { e: (west + east) / 2, n: (south + north) / 2, h: extent.h[0] };
		}
	}
	return best;
}

/** a pose from its text E,N,H,yaw,pitch,dist, as formatPose writes it; null when it is not one */
export function parsePose(text: string): Pose | null {
	const parts = text.split(',');
	if (parts.length !== 6 || parts.some((s) => s.trim() === '')) return null;
	const [e, n, h, yaw, pitch, dist] = parts.map(Number);
	if (![e, n, h, yaw, pitch, dist].every(Number.isFinite) || dist <= 0) return null;
	return { e, n, h, yaw, pitch, dist };
}

export function formatPose(p: Pose): string {
	const r = (v: number, d: number) => +v.toFixed(d);
	return [r(p.e, 2), r(p.n, 2), r(p.h, 2), r(p.yaw, 1), r(p.pitch, 1), r(p.dist, 1)].join(',');
}

export function clampPose(
	p: Pose,
	ground?: (e: number, n: number) => number,
	limits = LIMITS
): Pose {
	const q = {
		e: p.e,
		n: p.n,
		h: p.h,
		yaw: wrap(p.yaw),
		pitch: clamp(p.pitch, limits.pitch),
		dist: clamp(p.dist, limits.dist)
	};
	if (ground) {
		const c = cameraOf(q);
		const floor = Math.max(limits.floor, ground(c.e, c.n) + limits.clearance);
		if (c.h < floor) return { ...lookAt({ ...c, h: floor }, q), yaw: q.yaw };
	}
	return q;
}

/** unit view direction as a world offset */
function direction(yaw: number, pitch: number): Point {
	const c = Math.cos(pitch * RAD);
	return { e: Math.sin(yaw * RAD) * c, n: Math.cos(yaw * RAD) * c, h: Math.sin(pitch * RAD) };
}

export function cameraOf(p: Pose): Point {
	const d = direction(p.yaw, p.pitch);
	return { e: p.e - d.e * p.dist, n: p.n - d.n * p.dist, h: p.h - d.h * p.dist };
}

/** the engine camera that shows a pose */
export function viewOf(p: Pose): Camera {
	return { ...cameraOf(p), yaw: p.yaw, pitch: p.pitch, fov: FOV };
}

/** a place on screen in viewport heights from the centre, x right and y down */
export interface Spot {
	x: number;
	y: number;
}

/** where a world point shows in p's view; fov vertical in degrees */
export function project(p: Pose, fov: number, at: Point): Spot {
	const eye = cameraOf(p);
	const [de, dn, dh] = [at.e - eye.e, at.n - eye.n, at.h - eye.h];
	const [sy, cy] = [Math.sin(p.yaw * RAD), Math.cos(p.yaw * RAD)];
	const [sp, cp] = [Math.sin(p.pitch * RAD), Math.cos(p.pitch * RAD)];
	const along = de * sy + dn * cy;
	const span = 2 * Math.tan((fov * RAD) / 2) * (along * cp + dh * sp);
	return { x: (de * cy - dn * sy) / span, y: (along * sp - dh * cp) / span };
}

/** the pose of a camera at from looking at to; yaw is 0 when looking straight down */
export function lookAt(from: Point, to: Point): Pose {
	const [de, dn, dh] = [to.e - from.e, to.n - from.n, to.h - from.h];
	const dist = Math.hypot(de, dn, dh);
	return {
		e: to.e,
		n: to.n,
		h: to.h,
		yaw: wrap(Math.atan2(de, dn) / RAD),
		pitch: Math.asin(dh / dist) / RAD,
		dist
	};
}

/** turns the view to yaw and pitch about the camera, which stays put */
export function look(p: Pose, yaw: number, pitch: number, limits = LIMITS): Pose {
	const c = cameraOf(p);
	const q = clampPose({ ...p, yaw, pitch }, undefined, limits);
	const d = direction(q.yaw, q.pitch);
	return { ...q, e: c.e + d.e * q.dist, n: c.n + d.n * q.dist, h: c.h + d.h * q.dist };
}

/** camera height above the focus, floored so a level view still has a scale */
export function height(p: Pose): number {
	return p.dist * Math.max(Math.sin(-p.pitch * RAD), FLAT);
}

/** moves focus and camera together; right and forward follow the heading, metres */
export function fly(p: Pose, right: number, forward: number, up: number): Pose {
	const [s, c] = [Math.sin(p.yaw * RAD), Math.cos(p.yaw * RAD)];
	return { ...p, e: p.e + right * c + forward * s, n: p.n - right * s + forward * c, h: p.h + up };
}

/** slides along the ground; metres of screen at the focus, so forward stretches as the view flattens */
export function pan(p: Pose, right: number, forward: number): Pose {
	return fly(p, right, (forward * p.dist) / height(p), 0);
}

/** moves a toward b by fraction t: focus linearly, yaw the short way round, dist in log space */
export function blend(a: Pose, b: Pose, t: number): Pose {
	return {
		e: a.e + (b.e - a.e) * t,
		n: a.n + (b.n - a.n) * t,
		h: a.h + (b.h - a.h) * t,
		yaw: wrap(a.yaw + turn(a.yaw, b.yaw) * t),
		pitch: a.pitch + (b.pitch - a.pitch) * t,
		dist: a.dist * (b.dist / a.dist) ** t
	};
}

/** close enough that the rest of the way is not visible */
export function settled(a: Pose, b: Pose): boolean {
	const eps = a.dist * 1e-5;
	return (
		Math.abs(a.e - b.e) < eps &&
		Math.abs(a.n - b.n) < eps &&
		Math.abs(a.h - b.h) < eps &&
		Math.abs(a.dist - b.dist) < eps &&
		Math.abs(turn(a.yaw, b.yaw)) < 1e-3 &&
		Math.abs(a.pitch - b.pitch) < 1e-3
	);
}
