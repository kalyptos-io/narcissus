// the finished colour target onto the canvas, opaque

@group(0) @binding(0) var scene: texture_2d<f32>;

@fragment
fn fs(@builtin(position) coord: vec4f) -> @location(0) vec4f {
	return vec4f(textureLoad(scene, vec2i(coord.xy), 0).rgb, 1.0);
}
