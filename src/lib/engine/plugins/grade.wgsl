// the clarity grade on display colour, every pixel

@group(0) @binding(0) var scene: texture_2d<f32>;

// vibrance lifts muted colours most, a luma-only curve deepens blacks and keeps hue and greys
fn gradeGamma(color: vec3f) -> vec3f {
	let l: f32 = dot(color, vec3f(0.2126, 0.7152, 0.0722));
	let chroma: f32 = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
	let c: vec3f = l + (color - l) * (1.0 + 0.35 * (1.0 - chroma));
	var k: f32 = clamp((l - 0.02) / 0.98, 0.0, 1.0);
	k = mix(k, k * k * (3.0 - 2.0 * k), 0.2);
	return clamp(c * (k / max(l, 0.0001)), vec3f(0.0), vec3f(1.0));
}

@fragment
fn fs(@builtin(position) coord: vec4f) -> @location(0) vec4f {
	return vec4f(gradeGamma(textureLoad(scene, vec2i(coord.xy), 0).rgb), 1.0);
}
