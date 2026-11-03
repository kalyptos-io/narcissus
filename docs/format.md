# Guldmund Trees, version 2

A Guldmund tree stores one gaussian-splat world as static files:

- `world.json`, a short-lived manifest.
- Unit files under `u/`.

A change to this page is a new version. All integers are little-endian. `f32` is IEEE float32, `f16` IEEE float16.

Version 2 adds attribute streams: typed values for each splat that a producer gives meaning to (`.atr`, below). A version 2 reader reads version 1 trees. A tree without attributes is written as version 1.

## Grid, levels and pages

- Positions are easting, northing and height in metres, in the projected coordinate system and the height datum that `world.json` names. A reader does not interpret those names.
- Inside a unit, positions are local ENU: x east and y north of the unit's south-west corner, z height.
- A unit at pyramid level `L` is the square of side `250·2^L` whose south-west corner `(E, N)` is a multiple of that side. Its children are the four level `L-1` units inside it.
- Global level `g` holds about `4^-g` of the leaf density.
- A page `(g, i, j)` of a unit is the square of side `15.625·2^g` at column `i` (west to east) and row `j` (south to north) of the unit's grid at that level.
- The quadrant of a point in a page is `a + 2b`, with `a = 1` in the east half and `b = 1` in the north half. Quadrant `k` of page `(g, i, j)` covers the page `(g-1, 2i + a, 2j + b)`.

- A leaf (`L = 0`) holds `g = 0` (16×16 pages, its full detail) and `g = 1` (8×8 pages, one decimation of it).
- A unit at `L ≥ 1` holds `g = L + 1` (8×8 pages): one decimation of its children's `g = L` splats merged.
- A unit with no parent is a root. A root also holds `g = L + 2, L + 3, ...`, each one decimation of the last. It stops at the first level that has fewer than 100,000 splats, or at `g = L + 4`, where one page covers the unit. It keeps that last level.

A splat's page and quadrant come from its centre, clamped into the area its unit's existing children cover (for a leaf, its own square). The clamp does not move the splat.

Inside a page, splats are in quadrant order, as the quadrant starts in the header give. Inside a quadrant, the writer chooses the order. It should keep near splats together, because a reader can cull a run of consecutive splats as one. Guldmund's writer sorts them, stable, by the 3D Morton code of `trunc((p - min) / (max - min) · 1023)` per axis over the page's centres, with x in bit 0, y in bit 1 and z in bit 2.

## Names

`u/<L>/<E>/<N>.<hash>.<ext>`:

- `E` and `N` are the unit's south-west corner in whole metres.
- `hash` is the 16 lowercase hex digits of the file's blake2b digest of size 8.

A unit has a `.pack` and an `.idx`. A corrected unit also has a `.col`, and a unit with attributes an `.atr`. Every such file is immutable.

## `.pack`

In order:

1. The page blobs, back to back, coarsest level first. Within a level, blobs are in Morton order of `(i, j)`, with `i` in the even bits and `j` in the odd bits.
2. The page table, with rows as in `.idx`.
3. A 16-byte trailer:

| offset from end | type    | field                         |
| --------------- | ------- | ----------------------------- |
| -16             | u32     | byte offset of the page table |
| -12             | u32     | rows                          |
| -8              | 4 bytes | `GMPK`                        |
| -4              | u16     | version, 1                    |
| -2              | u16     | 0                             |

A page blob is a raw deflate stream (RFC 1951, no zlib or gzip wrapper) of the page payload.

### Page payload

A 128-byte header:

| offset | type    | field                                                     |
| ------ | ------- | --------------------------------------------------------- |
| 0      | u32     | count `n`                                                 |
| 4      | u32 × 3 | first splat of quadrants 1, 2, 3 (quadrant 0 starts at 0) |
| 16     | u16     | codebook size `k`; 0 means no SH1                         |
| 18     | u16     | 0                                                         |
| 20     | f32 × 3 | origin: the minimum of the centres, unit-local            |
| 32     | f32 × 3 | step per axis                                             |
| 44     | f32 × 3 | log-scale minimum per axis                                |
| 56     | f32 × 3 | log-scale maximum per axis                                |
| 68     | f32 × 3 | DC minimum per colour (`f_dc` units)                      |
| 80     | f32 × 3 | DC maximum per colour                                     |
| 92     | f32 × 9 | SH1 scale per coefficient                                 |

Then planes of `n` bytes each. Splat `t` is at byte `t` of every plane:

| planes | content                                                                 |
| ------ | ----------------------------------------------------------------------- |
| 0-5    | position x low, x high, y low, y high, z low, z high: zigzag u16 deltas |
| 6      | alpha                                                                   |
| 7      | rotation: index of the largest component                                |
| 8-10   | rotation: the other three components                                    |
| 11-13  | scale x, y, z                                                           |
| 14-16  | DC red, green, blue                                                     |
| 17-18  | SH1 label low, high (only when `k > 0`)                                 |

Then, when `k > 0`, the codebook: `k × 9` i8, entry-major, coefficient `3c + m` (below).

### Decoding a splat

- **Position**: per axis, `z` is the u16 of planes 0-5. `d = (z >> 1) ^ -(z & 1)`; `q_t = (q_{t-1} + d) mod 65536` with `q_{-1} = 0`; `p = origin + q · step`.
- **Alpha**: `byte / 255`, the opacity after the sigmoid.
- **Rotation**: a unit-length quaternion `(w, x, y, z)` that rotates the splat's axes into local ENU. The three stored components are `(byte / 255 - 0.5) · √2`, in order, without the largest. The largest is `√max(0, 1 - Σ v²)`.
- **Scale**: `exp(min + byte / 255 · (max - min))` per axis, in metres.
- **DC**: `f_dc = min + byte / 255 · (max - min)` per colour. The displayed base colour is `0.5 + C0 · f_dc`, with `C0 = 0.28209479177387814`.
- **SH1**: `sh[c][m] = codebook[label][3c + m] / 127 · scale[3c + m]` for colour `c` (red, green, blue) and `m = 0, 1, 2`. A view direction `d` (unit length, camera to splat, ENU) adds `C1 · (-d.y · sh[c][0] + d.z · sh[c][1] - d.x · sh[c][2])` to colour `c`, with `C1 = 0.4886025119029199`.

### Writing

- **Step** per axis: `max(0.0005 · 2^g, span / 65535)`, with span the extent of the page's centres on that axis.
- **Ranges**: the page's minimum and maximum. Values round to the nearest code.
- **Rotation**: normalised, with the sign that makes the largest component positive.
- **Codebook**: k-means over the page's SH1, with `k = min(n, 2048, max(256, ⌈n / 12 / 64⌉ · 64))`. Entries and scale are as for a linear i8 code, with the scale the per-coefficient maximum magnitude of the entries.

Measured on aerial data, 26 land pages and 8 water pages of one leaf: 14.9 bytes per splat on land and 9.8 on water, with rms errors of 0.25 mm in position, 0.35° in rotation, 0.4 % in scale, 0.8 of 255 in DC and 4.35 of 255 in SH1.

## `.idx`

An 8-byte prefix (`GMIX`, u16 version 1 or 2, u16 0), then a raw deflate stream of a 40-byte header in version 1, or 48 bytes in version 2:

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
| 40     | 8 bytes | attribute hash (version 2 only) |

Then the rows, 52 bytes each:

| offset | type    | field                                                       |
| ------ | ------- | ----------------------------------------------------------- |
| 0      | u8      | `g`                                                         |
| 1      | u8      | `i`                                                         |
| 2      | u8      | `j`                                                         |
| 3      | u8      | 0                                                           |
| 4      | u32     | count                                                       |
| 8      | u32 × 3 | first splat of quadrants 1, 2, 3                            |
| 20     | f32 × 3 | extent minimum: centres less 3σ along each axis, unit-local |
| 32     | f32 × 3 | extent maximum: centres plus 3σ along each axis, unit-local |
| 44     | u32     | blob offset in the pack                                     |
| 48     | u32     | blob length                                                 |

The σ of a splat on an axis is the square root of that axis's diagonal element of `R · diag(s²) · Rᵀ`, with `R` its rotation and `s` its scale before they are coded. The extent is the minimum and maximum over the page's splats.

Then the children, 9 bytes each: u8 quadrant `a + 2b`, 8-byte idx hash.

Then the descendants two and three levels down, 11 bytes each: u8 depth (2 or 3), u8 column, u8 row (of the unit's grid at that depth), 8-byte idx hash.

A root's rows include its extra levels. A unit that later gains a parent lists only its own level. Its pack keeps the other levels, unreferenced.

## `.col`

A unit's colour correction. A writer can replace it without a change to the pack. An 8-byte prefix (`GMCL`, u16 version 1, u16 0), then a raw deflate stream of:

| offset | type       | field                                                          |
| ------ | ---------- | -------------------------------------------------------------- |
| 0      | u16        | nodes a side `n`                                               |
| 2      | u16        | 0                                                              |
| 4      | f32        | pitch `p` in metres                                            |
| 8      | f32        | margin `m` in metres                                           |
| 12     | f32 × 12   | scale per channel                                              |
| 60     | i8 × 12 n² | channel-major, row `j` south to north, column `i` west to east |

- The centre of node `(i, j)` is `(-m + (i + 0.5) p, -m + (j + 0.5) p)`, unit-local.
- Each row is delta-coded along `i` with wrapping i8 arithmetic. The first value is raw. A value is `q / 127 · scale`.
- Channels 0-2 add to the displayed red, green and blue. Channel `3 + 3c + m` adds to `sh[c][m]` (ENU, as above).
- The correction applies to the splats of every page of the unit. A splat reads it bilinearly at its centre, clamped to the outer nodes.

## `.atr`

A unit's attribute streams. A writer can replace it without a change to the pack; the unit's `.idx` (version 2) names it by its hash, all zero for none.

In order:

1. The chunks, back to back. A chunk is a raw deflate stream of one stream's values for one page.
2. The tables.
3. A 24-byte trailer:

| offset from end | type    | field                                   |
| --------------- | ------- | --------------------------------------- |
| -24             | 8 bytes | hash of the `.pack` the values describe |
| -16             | u32     | byte offset of the tables               |
| -12             | u32     | chunks                                  |
| -8              | 4 bytes | `GMAT`                                  |
| -4              | u16     | version, 1                              |
| -2              | u16     | 0                                       |

The tables, not compressed:

- u16 streams `s`, u16 0.
- `s` stream names: u8 length, then that many bytes of UTF-8. A name is one that `world.json` declares.
- The chunks, 20 bytes each, ordered by blob offset, then stream:

| offset | type | field                                           |
| ------ | ---- | ----------------------------------------------- |
| 0      | u16  | stream, the index of its name above             |
| 2      | u8   | encoding                                        |
| 3      | u8   | 0                                               |
| 4      | u32  | blob offset of the page in the pack             |
| 8      | u32  | rows: the page's count                          |
| 12     | u32  | byte offset of the chunk in the file            |
| 16     | u32  | chunk length in bytes                           |

A chunk's values follow the page's splat order. A page with no chunk for a stream takes the stream's default for every splat. The pack's page table, not the `.idx`, is the reference: a chunk can describe a page that the `.idx` does not list (the unreferenced levels of a unit that gained a parent).

A value of a fixed stream is `components` scalars of its `type`, back to back. A value of a `records` stream is a run of bytes; the default is empty. Encodings:

| encoding | fixed stream                                                                                   | `records` stream                                                    |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 0 plain  | `rows` values                                                                                  | `rows + 1` u32 offsets into the bytes that follow, then the bytes   |
| 1 dictionary | u32 `k`, `k` values, then `rows` indices: u8 when `k ≤ 256`, else u16; `k ≤ 65536`         | not used                                                            |
| 2 sparse | u32 `m`, `m` u32 rows in increasing order, then their `m` values; other rows take the default  | u32 `m`, `m` u32 rows in increasing order, `m + 1` u32 offsets, then the bytes |

## `world.json`

```json
{
	"version": 1,
	"crs": "EPSG:25832",
	"height": "DVR90",
	"leaf": 250,
	"roots": [
		{ "level": 5, "e": 720000, "n": 6176000, "idx": "u/5/720000/6176000.0123456789abcdef.idx" }
	],
	"extent": { "e": [723000, 725000], "n": [6177000, 6179000], "h": [2.1, 49.9] }
}
```

| member    | value                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `version` | 1                                                                                                                  |
| `crs`     | the name of the projected coordinate system of `E` and `N`; any text that is not empty                             |
| `height`  | the name of the height datum; any text that is not empty                                                           |
| `leaf`    | 250, the side of a leaf unit in metres                                                                             |
| `roots`   | one or more units with no parent: `level`, `e`, `n` and the path of the `.idx`                                     |
| `extent`  | `[minimum, maximum]` of easting, northing and height over the extents of every root row, outward to the centimetre |

- Paths are relative to `world.json`.
- A writer may add its own members. A reader ignores the members that it does not know.
- `waiting`, if present, lists the `.idx` of units that no root reaches yet.
- `attributes`, if present, declares the streams that `.atr` files may hold, by name: `{ "type", "components", "default", "rule" }`.
  - `type`: `u8`, `u16`, `u32`, `i8`, `i16`, `i32`, `f16`, `f32`, or `records` for a run of bytes per splat.
  - `components`: 1 to 4 for a fixed stream; left out for `records`. `default`: a number, or one per component; left out for `records`.
  - `rule`: how the producer gave values to coarse splats, which merge others. `preserved`: each coarse value is exact for every splat it merges. `aggregated`: a reduction the producer defines. `unavailable`: coarse splats take the default. A reader never derives a coarse value from finer splats.
  - A name is namespaced, `<producer>.<name>`. What the values mean is the producer's and the reading application's; the format gives only their storage.
- A reader uses only `roots`.
- A publisher writes every unit file before the `world.json` that reaches it.
- A reader that finds a missing unit file reloads `world.json`.

## Delivery

A reader makes whole-file GETs and single-range GETs (`Range: bytes=a-b`).
