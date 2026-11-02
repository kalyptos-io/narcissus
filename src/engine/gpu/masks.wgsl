// prisms that hide, fade or tint splats by centre; masks.ts writes the records, their edges, then the
// clusters' lists

// words of a record: min x y, max x y, min z, max z (f32), first edge word, edges, opacity (f32),
// tint (pack4x8unorm), outside
const MASK_WORDS: u32 = 11u;

@group(1) @binding(0) var<storage, read> masks: array<u32>;

// what the masks over a splat leave of it: opacity times its own, colour * (1 - tint.a) + tint.rgb
struct Effect {
	tint: vec4f,
	opacity: f32,
}

fn maskFloat(k: u32) -> f32 {
	return bitcast<f32>(masks[k]);
}

// list entries: a record's index, this bit set where the mask acts on every centre of the cluster
const INSIDE: u32 = 0x80000000u;

// the effect on p, floating-origin frame, of the cluster's masks in list order
fn masked(cluster: Cluster, p: vec3f) -> Effect {
	var effect = Effect(vec4f(0.0), 1.0);
	for (var k = 0u; k < cluster.maskCount; k++) {
		let entry = masks[cluster.maskList + k];
		let m = (entry & ~INSIDE) * MASK_WORDS;
		if ((entry & INSIDE) == 0u && !acts(m, p)) {
			continue;
		}
		let opacity = maskFloat(m + 8u);
		if (opacity == 0.0) {
			return Effect(vec4f(0.0), 0.0);
		}
		effect.opacity *= opacity;
		let tint = unpack4x8unorm(masks[m + 9u]);
		effect.tint = effect.tint * (1.0 - tint.a) + vec4f(tint.rgb * tint.a, tint.a);
	}
	return effect;
}

// whether record m acts on p: within its edges by even-odd and its z range, xor its outside flag
fn acts(m: u32, p: vec3f) -> bool {
	var odd = false;
	if (p.x >= maskFloat(m) && p.y >= maskFloat(m + 1u) && p.x <= maskFloat(m + 2u) &&
		p.y <= maskFloat(m + 3u) && p.z >= maskFloat(m + 4u) && p.z <= maskFloat(m + 5u)) {
		let first = masks[m + 6u];
		for (var e = first; e < first + 4u * masks[m + 7u]; e += 4u) {
			let a = vec2f(maskFloat(e), maskFloat(e + 1u));
			let b = vec2f(maskFloat(e + 2u), maskFloat(e + 3u));
			if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
				odd = !odd;
			}
		}
	}
	return odd != (masks[m + 10u] != 0u);
}
