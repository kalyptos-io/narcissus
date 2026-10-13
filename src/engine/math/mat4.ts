// column-major 4x4 matrices in the ENU frame: x east, y north, z up; view space looks down -z

export type Mat4 = Float32Array | Float64Array;
export type Vec3 = readonly [number, number, number] | Float32Array | Float64Array;

/** unit vector the camera looks along, for yaw clockwise from north and pitch up, radians */
export function forward(yaw: number, pitch: number): [number, number, number] {
	const c = Math.cos(pitch);
	return [Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch)];
}

/** world to view for a camera at eye; roll is always level */
export function view<T extends Mat4>(out: T, eye: Vec3, yaw: number, pitch: number): T {
	const [fx, fy, fz] = forward(yaw, pitch);
	const rx = Math.cos(yaw);
	const ry = -Math.sin(yaw);
	// up = right x forward
	const ux = ry * fz;
	const uy = -rx * fz;
	const uz = rx * fy - ry * fx;
	out[0] = rx;
	out[1] = ux;
	out[2] = -fx;
	out[3] = 0;
	out[4] = ry;
	out[5] = uy;
	out[6] = -fy;
	out[7] = 0;
	out[8] = 0;
	out[9] = uz;
	out[10] = -fz;
	out[11] = 0;
	out[12] = -(rx * eye[0] + ry * eye[1]);
	out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
	out[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
	out[15] = 1;
	return out;
}

/** clip z in 0..1, as webgpu expects; fov vertical in radians */
export function perspective<T extends Mat4>(
	out: T,
	fov: number,
	aspect: number,
	near: number,
	far: number
): T {
	const f = 1 / Math.tan(fov / 2);
	out.fill(0);
	out[0] = f / aspect;
	out[5] = f;
	out[10] = far / (near - far);
	out[11] = -1;
	out[14] = (near * far) / (near - far);
	return out;
}

// holds a product until it is whole, since out may be a or b
const scratch = new Float64Array(16);

export function multiply<T extends Mat4>(out: T, a: Mat4, b: Mat4): T {
	for (let c = 0; c < 4; c++)
		for (let row = 0; row < 4; row++) {
			let s = 0;
			for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
			scratch[c * 4 + row] = s;
		}
	out.set(scratch);
	return out;
}

/** null when singular */
export function invert<T extends Mat4>(out: T, m: Mat4): T | null {
	const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
	const b00 = a00 * a11 - a01 * a10;
	const b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10;
	const b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11;
	const b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30;
	const b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30;
	const b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31;
	const b11 = a22 * a33 - a23 * a32;
	const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	if (!det) return null;
	const d = 1 / det;
	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
	return out;
}

/** m applied to the point p, without the perspective divide */
export function transform(m: Mat4, p: Vec3): [number, number, number, number] {
	const [x, y, z] = p;
	return [
		m[0] * x + m[4] * y + m[8] * z + m[12],
		m[1] * x + m[5] * y + m[9] * z + m[13],
		m[2] * x + m[6] * y + m[10] * z + m[14],
		m[3] * x + m[7] * y + m[11] * z + m[15]
	];
}
