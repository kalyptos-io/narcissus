// prisms that hide splats by centre; masks.ts writes the records, their vertices, then the clusters' lists

// words of a record: min x y, max x y, min z, max z (f32), first vertex word, vertices
const MASK_WORDS: u32 = 8u;

@group(1) @binding(0) var<storage, read> masks: array<u32>;

fn maskFloat(k: u32) -> f32 {
	return bitcast<f32>(masks[k]);
}

// p, floating-origin frame, inside a mask of the cluster's list: its polygon by the even-odd rule and its z range
fn masked(cluster: Cluster, p: vec3f) -> bool {
	for (var k = 0u; k < cluster.maskCount; k++) {
		let m = masks[cluster.maskList + k] * MASK_WORDS;
		if (p.x < maskFloat(m) || p.y < maskFloat(m + 1u) || p.x > maskFloat(m + 2u) ||
			p.y > maskFloat(m + 3u) || p.z < maskFloat(m + 4u) || p.z > maskFloat(m + 5u)) {
			continue;
		}
		let first = masks[m + 6u];
		let n = masks[m + 7u];
		var odd = false;
		var b = vec2f(maskFloat(first + 2u * n - 2u), maskFloat(first + 2u * n - 1u));
		for (var i = 0u; i < n; i++) {
			let a = vec2f(maskFloat(first + 2u * i), maskFloat(first + 2u * i + 1u));
			if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
				odd = !odd;
			}
			b = a;
		}
		if (odd) {
			return true;
		}
	}
	return false;
}
