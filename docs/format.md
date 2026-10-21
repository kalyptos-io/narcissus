# Guldmund Trees, version 2

A Guldmund tree stores one world: a gaussian-splat scene of any size, as static files that a viewer streams by range request. It is a short-lived manifest, `world.json`, and immutable unit files under `u/` that are named by their content. This page is the contract between writers and readers; a change to it is a new version. All integers are little-endian; `f32` is IEEE float32.

## Grid, bands and pages

- Positions are easting, northing and height in metres, in the projected coordinate system and the height datum that `world.json` names. A reader does not interpret those names. Inside a unit positions are local ENU: x east and y north of the unit's south-west corner, z height.
- A unit at pyramid level `L` is the square of side `250·2^L` whose south-west corner `(E, N)` is a multiple of that side. Its children are the four level `L-1` units inside it; child `a + 2b` has `a = 1` in the east half and `b = 1` in the north half.
- Band `g` holds about `4^-g` of the leaf density. A page `(g, i, j)` of a unit is the square of side `15.625·2^g` at column `i` (west to east) and row `j` (south to north) of the unit's grid at that band.

## The tree

- Every node is a gaussian splat. A node with children is a parent: its family is `count` consecutive nodes of one page, which it stands for when drawn at a distance. The fit splats, the scene at full detail, are the nodes without children.
- A unit stores families in its own bands: a leaf (`L = 0`) in bands 0 and 1, a unit at `L ≥ 1` in band `L + 1`. A family's page is the page of its band whose square holds its parent's centre, clamped into the unit's square. A writer puts the families of coarser parents in coarser bands.
- A unit's top nodes are the parents of families in its own bands that are not themselves members of one. Its parent unit stores a copy of each as a member of one of its own families, and the copy's family lies in the child. So a link reaches a family in the same unit or in a direct child, and every node of a unit's own bands is a member of exactly one family there.
- A root, a unit with no parent, also stores a crown: bands `b + 1, b + 2, ...` (`b` its coarsest own band) whose families are merges of the band below's coarsest nodes, the first over its top nodes, until fewer than 100,000 nodes are left, then a top page that holds those. A unit that has gained a parent lists only its own bands; its pack may keep its crown pages, unreferenced.
- A reader draws a cut: a set of nodes with exactly one node on every path from a node of a root's top page to a fit splat. It refines a drawn node by drawing its family in its place, once the family's page is resident.
- A family has at most 255 members and a page at most 2^20 nodes. Inside a page the order of families, and of the members of a family, is the writer's.

## Names

`u/<L>/<E>/<N>.<hash>.<ext>` with `E` and `N` the unit's south-west corner in whole metres and `hash` the 16 lowercase hex digits of the file's blake2b digest of size 8. A unit has a `.pack`, an `.idx` and, when corrected, a `.col`. Every such file is immutable.

## `.pack`

Page blobs back to back in row order. Rows run through the unit's own bands from fine to coarse, Morton order of `(i, j)` within a band, then its crown bands from fine to coarse, then its top page; so dropping the crown rows leaves the row of every other page unchanged, and links name rows. Then the page table (rows as in `.idx`), then a 20-byte trailer:

| offset from end | type    | field                                                 |
| --------------- | ------- | ----------------------------------------------------- |
| -20             | u32     | fit splats: the nodes without children (0 but a leaf) |
| -16             | u32     | byte offset of the page table                         |
| -12             | u32     | rows                                                  |
| -8              | 4 bytes | `GMPK`                                                |
| -4              | u16     | version, 2                                            |
| -2              | u16     | 0                                                     |

A page blob is a raw deflate stream (RFC 1951, no zlib or gzip wrapper) of the page payload.

### Page payload

A 128-byte header:

| offset | type    | field                                          |
| ------ | ------- | ---------------------------------------------- |
| 0      | u32     | count `n`                                      |
| 4      | u32     | parents `m`: the nodes with children           |
| 8      | u32 × 2 | 0                                              |
| 16     | u16     | codebook size `k`; 0 means no SH1              |
| 18     | u16     | 0                                              |
| 20     | f32 × 3 | origin: the minimum of the centres, unit-local |
| 32     | f32 × 3 | step per axis                                  |
| 44     | f32 × 3 | log-scale minimum per axis                     |
| 56     | f32 × 3 | log-scale maximum per axis                     |
| 68     | f32 × 3 | DC minimum per colour (`f_dc` units)           |
| 80     | f32 × 3 | DC maximum per colour                          |
| 92     | f32 × 9 | SH1 scale per coefficient                      |

Then planes of `n` bytes each, node `t` at byte `t` of every plane:

| planes | content                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 0-5    | position x low, x high, y low, y high, z low, z high: zigzag u16 deltas |
| 6      | opacity, low byte of an IEEE binary16                                   |
| 7      | rotation: index of the largest component                                |
| 8-10   | rotation: the other three components                                    |
| 11-13  | scale x, y, z                                                           |
| 14-16  | DC red, green, blue                                                     |
| 17     | opacity, high byte                                                      |
| 18     | children: the family's count, 0 for none                                |
| 19-20  | SH1 label low, high (only when `k > 0`)                                 |

Then four planes of `m` bytes, the link of the `s`-th parent of the page (in node order) at byte `s` of each: bits 0-7, 8-15, 16-23 and 24-31 of a u32. Then, when `k > 0`, the codebook: `k × 9` i8, entry-major, coefficient `3c + m` (below).

### Decoding a node

- **Position**: `z` is the u16 of planes 0-5 per axis; `d = (z >> 1) ^ -(z & 1)`; `q_t = (q_{t-1} + d) mod 65536` with `q_{-1} = 0`; `p = origin + q · step`.
- **Opacity**: `α`, the binary16 of planes 6 and 17, `0 ≤ α ≤ 1000`. At a point where the splat's gaussian is `G = exp(-½ d²)`, `d` the Mahalanobis distance, it covers `α · G` when `α ≤ 1` and `1 - (1 - G)^α` above: a merged splat flat-topped where it stands for many. Fit splats have `α ≤ 1`, their opacity after the sigmoid.
- **Link**: bits 0-19 the first node of the family in its page; bits 20-28 that page's row in its unit; bits 29-31 the unit, 0 for this one and `1 + q` for its child at quadrant `q`. The family is the `count` nodes from the first.
- **Rotation**: a unit quaternion `(w, x, y, z)` rotating the splat's axes into local ENU. The three stored components are `(byte / 255 - 0.5) · √2` in order, skipping the index; the largest is `√max(0, 1 - Σ v²)`.
- **Scale**: `exp(min + byte / 255 · (max - min))` per axis, in metres.
- **DC**: `f_dc = min + byte / 255 · (max - min)` per colour; the displayed base colour is `0.5 + C0 · f_dc`, `C0 = 0.28209479177387814`.
- **SH1**: `sh[c][m] = codebook[label][3c + m] / 127 · scale[3c + m]` for colour `c` (red, green, blue) and `m = 0, 1, 2`. A view direction `d` (unit, camera to splat, ENU) adds `C1 · (-d.y · sh[c][0] + d.z · sh[c][1] - d.x · sh[c][2])` to colour `c`, `C1 = 0.4886025119029199`.

### Writing

- step per axis: `max(0.0005 · 2^g, span / 65535)`, span the extent of the page's centres on that axis and `g` the page's band.
- ranges are the page's minimum and maximum; values round to the nearest code.
- rotation: normalised, sign chosen so the largest component is positive.
- opacity: rounded to the nearest binary16.
- codebook: k-means over the page's SH1, `k = min(n, 2048, max(256, ⌈n / 12 / 64⌉ · 64))`; entries and scale as for a linear i8 code, scale the per-coefficient maximum magnitude of the entries.

Measured on aerial data, 26 land pages and 8 water pages of one leaf: 14.9 bytes per splat on land and 9.8 on water, with errors of 0.25 mm rms in position, 0.35° in rotation, 0.4 % in scale, 0.8 of 255 in DC and 4.35 of 255 in SH1.

## `.idx`

An 8-byte prefix, `GMIX`, u16 version 2, u16 0, then a raw deflate stream of:

| offset | type    | field                          |
| ------ | ------- | ------------------------------ |
| 0      | u8      | level `L`                      |
| 1      | 3 bytes | 0                              |
| 4      | i32     | `E`                            |
| 8      | i32     | `N`                            |
| 12     | 8 bytes | pack hash                      |
| 20     | u32     | pack size in bytes             |
| 24     | 8 bytes | colour hash, all zero for none |
| 32     | u16     | rows                           |
| 34     | u8      | children                       |
| 35     | u8      | 0                              |
| 36     | u16     | descendants                    |
| 38     | u16     | 0                              |

Then the rows, 40 bytes each:

| offset | type    | field                                                             |
| ------ | ------- | ----------------------------------------------------------------- |
| 0      | u8      | band `g`                                                          |
| 1      | u8      | `i`                                                               |
| 2      | u8      | `j`                                                               |
| 3      | u8      | flags: bit 0 the top page                                         |
| 4      | u32     | count                                                             |
| 8      | f32 × 3 | extent minimum: centres less `k(α)` σ along each axis, unit-local |
| 20     | f32 × 3 | extent maximum                                                    |
| 32     | u32     | blob offset in the pack                                           |
| 36     | u32     | blob length                                                       |

`k(α)` is 3 for `α ≤ 1` and `√(2 ln 255α)` above, where a flat-topped splat's cover falls to 1/255.

Then the children, 9 bytes each: u8 quadrant `a + 2b`, 8-byte idx hash. Then the descendants two and three levels down, 11 bytes each: u8 depth (2 or 3), u8 column, u8 row (of the unit's grid at that depth), 8-byte idx hash. A reader can fetch a unit's grandchildren and great-grandchildren without waiting for its children.

A root's rows include its crown pages and its top page; a unit that has since gained a parent lists only its own bands.

## `.col`

A unit's colour correction. A writer can replace it without a change to the pack. An 8-byte prefix, `GMCL`, u16 version 1, u16 0, then a raw deflate stream of:

| offset | type       | field                                                          |
| ------ | ---------- | -------------------------------------------------------------- |
| 0      | u16        | nodes a side `n`                                               |
| 2      | u16        | 0                                                              |
| 4      | f32        | pitch `p` in metres                                            |
| 8      | f32        | margin `m` in metres                                           |
| 12     | f32 × 12   | scale per channel                                              |
| 60     | i8 × 12 n² | channel-major, row `j` south to north, column `i` west to east |

Node `(i, j)` is centred at `(-m + (i + 0.5) p, -m + (j + 0.5) p)`, unit-local. Each row is delta-coded along `i` with wrapping i8 arithmetic, the first value raw; a value is `q / 127 · scale`. Channels 0-2 add to the displayed red, green and blue; channel `3 + 3c + m` adds to `sh[c][m]` (ENU, as above). A splat reads it bilinearly at its centre, clamped to the outer nodes, and applies it to every node its unit stores, the copies of its children's top nodes among them.

## `world.json`

```json
{
	"version": 2,
	"crs": "EPSG:25832",
	"height": "DVR90",
	"leaf": 250,
	"roots": [
		{ "level": 5, "e": 720000, "n": 6176000, "idx": "u/5/720000/6176000.0123456789abcdef.idx" }
	],
	"extent": { "e": [723000, 725000], "n": [6177000, 6179000], "h": [2.1, 49.9] }
}
```

| member    | value                                                                                  |
| --------- | -------------------------------------------------------------------------------------- |
| `version` | 2                                                                                      |
| `crs`     | the name of the projected coordinate system of `E` and `N`; any text that is not empty |
| `height`  | the name of the height datum; any text that is not empty                               |
| `leaf`    | 250, the side of a leaf unit in metres                                                 |
| `roots`   | one or more units with no parent: `level`, `e`, `n` and the path of the `.idx`         |
| `extent`  | the bounds of the world as `[minimum, maximum]` of easting, northing and height        |

Paths are relative to `world.json`. A writer may add members of its own, and a reader ignores the members it does not know.

A publisher writes every unit file before the `world.json` that reaches it. A reader that meets a missing unit file reloads `world.json`.

## Delivery

A reader makes whole-file GETs and single-range GETs (`Range: bytes=a-b`). A single range is CORS-safelisted, so a reader on another origin sends no preflight. Any static file server that answers range requests can serve a tree; HTTP/2 or later keeps the many small requests cheap.
