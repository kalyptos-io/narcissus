// prisms that hide, fade or tint splats by centre; masks.ts writes the records, their edges as runs
// of vertices, then the clusters' lists into the pass's extension, every word offset its

// words of a record: min x y, max x y, min z, max z (f32), first run word, run words, opacity (f32),
// tint (pack4x8unorm), outside; a run: its count of vertices, then their x y (f32)
const MASK_WORDS: u32 = 11u;

// what the masks over a splat leave of it: opacity times its own, colour * (1 - tint.a) + tint.rgb
struct Effect {
	tint: vec4f,
	opacity: f32,
}

fn maskFloat(k: u32) -> f32 {
	return bitcast<f32>(extension[k]);
}

// list entries: a record's first word, this bit set where the mask acts on every centre of the cluster
const INSIDE: u32 = 0x80000000u;

// the effect on p, floating-origin frame, of the cluster's masks in list order
fn masked(cluster: Cluster, p: vec3f) -> Effect {
	var effect = Effect(vec4f(0.0), 1.0);
	for (var k = 0u; k < cluster.maskCount; k++) {
		let entry = extension[cluster.maskList + k];
		let m = entry & ~INSIDE;
		if ((entry & INSIDE) == 0u && !acts(m, p)) {
			continue;
		}
		let opacity = maskFloat(m + 8u);
		if (opacity == 0.0) {
			return Effect(vec4f(0.0), 0.0);
		}
		effect.opacity *= opacity;
		let tint = unpack4x8unorm(extension[m + 9u]);
		effect.tint = effect.tint * (1.0 - tint.a) + vec4f(tint.rgb * tint.a, tint.a);
	}
	return effect;
}

// whether record m acts on p: within its edges by even-odd and its z range, xor its outside flag
fn acts(m: u32, p: vec3f) -> bool {
	var odd = false;
	if (p.x >= maskFloat(m) && p.y >= maskFloat(m + 1u) && p.x <= maskFloat(m + 2u) &&
		p.y <= maskFloat(m + 3u) && p.z >= maskFloat(m + 4u) && p.z <= maskFloat(m + 5u)) {
		let end = extension[m + 6u] + extension[m + 7u];
		var run = extension[m + 6u];
		while (run < end) {
			// each vertex joins the one before, the first the last
			let last = run + 2u * extension[run] - 1u;
			var a = vec2f(maskFloat(last), maskFloat(last + 1u));
			for (var v = run + 1u; v <= last; v += 2u) {
				let b = vec2f(maskFloat(v), maskFloat(v + 1u));
				if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
					odd = !odd;
				}
				a = b;
			}
			run = last + 2u;
		}
	}
	return odd != (extension[m + 10u] != 0u);
}
