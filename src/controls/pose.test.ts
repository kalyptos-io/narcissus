import { describe, expect, it } from 'vitest';
import type { World } from '../engine/index.ts';
import {
	blend,
	cameraOf,
	clampPose,
	defaultView,
	DIST_RANGE,
	fly,
	formatPose,
	height,
	look,
	lookAt,
	opening,
	pan,
	parsePose,
	project,
	settled,
	type Pose
} from './pose.ts';

const at = { e: 866_125.25, n: 6_121_010.5, h: 21.4 };
const pose = (yaw: number, pitch: number, dist: number): Pose => ({ ...at, yaw, pitch, dist });

function expectPose(actual: Pose, expected: Pose, digits = 6) {
	for (const k of ['e', 'n', 'h', 'yaw', 'pitch', 'dist'] as const)
		expect(actual[k], k).toBeCloseTo(expected[k], digits);
}

describe('pose and scene', () => {
	it.each([
		[0, 0, 10],
		[45, -35, 300],
		[180, -10, 20_000],
		[270, -60, 1],
		[359.9, -89.9, 5000]
	])('round-trips yaw %d pitch %d dist %d', (yaw, pitch, dist) => {
		const p = pose(yaw, pitch, dist);
		expectPose(lookAt(cameraOf(p), p), p);
	});

	it('puts the camera behind the focus', () => {
		const c = cameraOf(pose(0, 0, 100));
		// looking north level, so the camera sits 100 m south
		expect(c.e).toBeCloseTo(at.e, 9);
		expect(c.n).toBeCloseTo(at.n - 100, 9);
		expect(c.h).toBeCloseTo(at.h, 9);
	});

	it('puts the camera straight above the focus at pitch -90', () => {
		const c = cameraOf(pose(123, -90, 50));
		expect(c.e).toBeCloseTo(at.e, 9);
		expect(c.n).toBeCloseTo(at.n, 9);
		expect(c.h).toBeCloseTo(at.h + 50, 9);
	});

	it('projects the focus to the centre and a 45 degree view half a viewport each way', () => {
		const edge = 100 * Math.tan(22.5 * (Math.PI / 180));
		const spot = (p: Pose, e: number, n: number, h: number) =>
			project(p, 45, { e: at.e + e, n: at.n + n, h: at.h + h });
		const expectSpot = (s: { x: number; y: number }, x: number, y: number) => {
			expect(s.x).toBeCloseTo(x, 9);
			expect(s.y).toBeCloseTo(y, 9);
		};
		const north = pose(0, 0, 100);
		expectSpot(spot(north, 0, 0, 0), 0, 0);
		expectSpot(spot(north, edge, 0, 0), 0.5, 0);
		expectSpot(spot(north, 0, 0, edge), 0, -0.5);
		// looking east, south is on the right
		expectSpot(spot(pose(90, 0, 100), 0, -edge, 0), 0.5, 0);
		// looking down with north up
		expectSpot(spot(pose(0, -90, 100), 0, edge, 0), 0, -0.5);
		expectSpot(spot(pose(0, -90, 100), edge, 0, 0), 0.5, 0);
	});
});

describe('parse and format', () => {
	const parse = (query: string) => parsePose(new URLSearchParams(query), () => 0);

	it('round-trips a formatted pose', () => {
		const p = { e: 866125.37, n: 6121010.52, h: 21.4, yaw: 212.5, pitch: -41.2, dist: 312.8 };
		expect(parse(`cam=${formatPose(p)}`)).toEqual(p);
	});

	it('round-trips a query string', () => {
		const s = '866125.37,6121010.52,21.4,212.5,-41.2,312.8';
		expect(formatPose(parse(`cam=${s}`)!)).toBe(s);
	});

	it('rounds to centimetres and tenths of a degree', () => {
		const p = { e: 1.23456, n: 2.34567, h: 3.45678, yaw: 4.56, pitch: -5.67, dist: 6.78 };
		expect(formatPose(p)).toBe('1.23,2.35,3.46,4.6,-5.7,6.8');
	});

	it('reads ?at as the default view over the point, at its ground height', () => {
		const ground = (e: number, n: number) => (e === 866125 && n === 6121010 ? 12.5 : NaN);
		expect(parsePose(new URLSearchParams('at=866125,6121010'), ground)).toEqual({
			e: 866125,
			n: 6121010,
			h: 12.5,
			...defaultView
		});
	});

	it('prefers ?cam over ?at', () => {
		expect(parse('cam=1,2,3,4,-5,6&at=7,8')).toEqual({
			e: 1,
			n: 2,
			h: 3,
			yaw: 4,
			pitch: -5,
			dist: 6
		});
	});

	it('falls back to ?at when ?cam is malformed', () => {
		expect(parse('cam=1,2,3&at=7,8')?.e).toBe(7);
	});

	it.each([
		'',
		'cam=',
		'cam=1,2,3,4,5',
		'cam=1,2,3,4,5,6,7',
		'cam=1,2,,4,-5,6',
		'cam=1,2,3,4,-5,abc',
		'cam=1,2,3,4,-5,NaN',
		'cam=1,2,3,Infinity,-5,6',
		'cam=1,2,3,4,-5,0',
		'cam=1,2,3,4,-5,-10',
		'at=',
		'at=1',
		'at=1,2,3',
		'at=1,',
		'at=x,2'
	])('rejects %j', (query) => {
		expect(parse(query)).toBeNull();
	});
});

describe('clampPose', () => {
	it('wraps yaw into [0, 360)', () => {
		expect(clampPose(pose(370, -30, 10)).yaw).toBeCloseTo(10, 9);
		expect(clampPose(pose(-90, -30, 10)).yaw).toBe(270);
		expect(clampPose(pose(360, -30, 10)).yaw).toBe(0);
	});

	it('stops tilt twenty degrees below the horizon and limits zoom', () => {
		expect(clampPose(pose(0, 20, 10)).pitch).toBe(-20);
		expect(clampPose(pose(0, -120, 10)).pitch).toBe(-90);
		expect(clampPose(pose(0, -30, 0.01)).dist).toBe(DIST_RANGE[0]);
		expect(clampPose(pose(0, -30, 1e9)).dist).toBe(DIST_RANGE[1]);
	});

	it('leaves a valid pose alone', () => {
		expect(clampPose(pose(212.5, -41.2, 312.8))).toEqual(pose(212.5, -41.2, 312.8));
	});

	it.each([-90, -35, -20])('keeps camera elevation at least fifty metres at pitch %d', (pitch) => {
		const p = pose(123, pitch, 1);
		const before = cameraOf(p);
		const q = clampPose(p, () => at.h);
		const after = cameraOf(q);
		expect(after.h).toBeCloseTo(50, 9);
		expect(after.e).toBeCloseTo(before.e, 9);
		expect(after.n).toBeCloseTo(before.n, 9);
		expect(q).toMatchObject({ ...at, yaw: p.yaw });
		expect(q.pitch).toBeLessThanOrEqual(-20);
		expect(q.pitch).toBeGreaterThanOrEqual(-90);
		expectPose(
			clampPose(q, () => at.h),
			q
		);
	});

	it('samples the ground under the camera, not the focus', () => {
		const p = pose(90, -20, 10);
		const ground = (e: number) => (e < at.e - 5 ? 60 : 0);
		expect(cameraOf(clampPose(p, ground)).h).toBeCloseTo(70, 9);
	});

	it('allows close views of raised surfaces when the camera is above ground', () => {
		const p = { ...pose(0, -35, 2), h: 60 };
		expect(clampPose(p, () => 0)).toEqual(p);
	});

	it('enforces clearance after flying downward', () => {
		const p = fly(pose(90, -35, 30), 0, 0, -20);
		expect(cameraOf(clampPose(p, () => at.h)).h).toBeCloseTo(50, 9);
	});

	it('enforces clearance while smoothing across higher ground', () => {
		const a = { ...pose(0, -90, 50 - at.h), e: 0 };
		const b = { ...a, e: 20 };
		const ground = (e: number) => at.h + (e > 5 && e < 15 ? 40 : 0);
		expect(clampPose(a, ground)).toEqual(a);
		expect(clampPose(b, ground)).toEqual(b);
		const mid = clampPose(blend(a, b, 0.5), ground);
		expect(cameraOf(mid).h).toBeCloseTo(ground(mid.e) + 10, 9);
	});
});

describe('moves', () => {
	it('look turns the view about a fixed camera', () => {
		const p = pose(10, -30, 400);
		const q = look(p, 80, -50);
		expect(q.yaw).toBe(80);
		expect(q.pitch).toBe(-50);
		expect(q.dist).toBe(400);
		const [a, b] = [cameraOf(p), cameraOf(q)];
		expect(b.e).toBeCloseTo(a.e, 6);
		expect(b.n).toBeCloseTo(a.n, 6);
		expect(b.h).toBeCloseTo(a.h, 6);
	});

	it('look stops twenty degrees below the horizon', () => {
		expect(look(pose(0, -30, 100), 0, 15).pitch).toBe(-20);
	});

	it('fly moves along the heading', () => {
		const p = fly(pose(90, -30, 100), 0, 10, 2);
		expect(p.e).toBeCloseTo(at.e + 10, 9);
		expect(p.n).toBeCloseTo(at.n, 9);
		expect(p.h).toBeCloseTo(at.h + 2, 9);
		const q = fly(pose(0, -30, 100), 5, 0, 0);
		expect(q.e).toBeCloseTo(at.e + 5, 9);
		expect(q.n).toBeCloseTo(at.n, 9);
	});

	it('pan stays on the ground and stretches forward as the view flattens', () => {
		const steep = pan(pose(0, -90, 100), 0, 10);
		expect(steep.n).toBeCloseTo(at.n + 10, 9);
		expect(steep.h).toBe(at.h);
		const shallow = pan(pose(0, -30, 100), 0, 10);
		expect(shallow.n).toBeCloseTo(at.n + 20, 9);
		const level = pan(pose(0, 0, 100), 0, 10);
		expect(level.n).toBeCloseTo(at.n + 100, 9);
	});

	it('height is the camera over the focus, floored for a level view', () => {
		expect(height(pose(0, -30, 100))).toBeCloseTo(50, 9);
		expect(height(pose(0, -90, 100))).toBeCloseTo(100, 9);
		expect(height(pose(0, 0, 100))).toBeCloseTo(10, 9);
	});

	it('scales pan and fly with distance from 10 m to 20 km', () => {
		for (const dist of [10, 20_000]) {
			const p = pose(0, -45, dist);
			expect(pan(p, 0.01 * dist, 0).e - at.e).toBeCloseTo(0.01 * dist, 6);
			expect(height(p) / dist).toBeCloseTo(Math.SQRT1_2, 9);
		}
	});
});

describe('blend', () => {
	const a = pose(350, -20, 100);
	const b = { ...pose(10, -40, 400), e: at.e + 100 };

	it('starts at a and ends at b', () => {
		expectPose(blend(a, b, 0), a);
		expectPose(blend(a, b, 1), b);
	});

	it('turns the short way and zooms in log space', () => {
		const mid = blend(a, b, 0.5);
		expect(mid.yaw).toBeCloseTo(0, 9);
		expect(mid.pitch).toBeCloseTo(-30, 9);
		expect(mid.dist).toBeCloseTo(200, 9);
		expect(mid.e).toBeCloseTo(at.e + 50, 9);
	});

	it('settles once the gap is invisible', () => {
		expect(settled(a, b)).toBe(false);
		expect(settled(blend(a, b, 1 - 1e-9), b)).toBe(true);
		expect(settled(pose(359.9999, -20, 100), pose(0.0001, -20, 100))).toBe(true);
	});
});

describe('opening', () => {
	const extent: World['extent'] = {
		e: [716737.88, 724518.02],
		n: [6175983.75, 6179013.84],
		h: [-6.87, 93.54]
	};
	const roots = [
		{ level: 2, e: 716000, n: 6178000, idx: '' },
		{ level: 2, e: 724000, n: 6176000, idx: '' }
	];

	it('opens on the middle of the nearest root when the centre falls between roots', () => {
		const { e, n, h } = opening({ leaf: 250, roots, extent });
		expect([e, n, h]).toEqual([(724000 + 724518.02) / 2, 6176500, -6.87]);
	});

	it('keeps the centre when a root covers it', () => {
		const one = [{ level: 5, e: 720000, n: 6176000, idx: '' }];
		expect(opening({ leaf: 250, roots: one, extent })).toEqual({
			e: (716737.88 + 724518.02) / 2,
			n: (6175983.75 + 6179013.84) / 2,
			h: -6.87
		});
	});
});
