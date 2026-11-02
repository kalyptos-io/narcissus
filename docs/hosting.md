# Hosting a world

A world is a folder of static files ([format.md](format.md)). Any server or object store with range requests can serve it.

```
world.json                              the manifest; small, replaced when the world changes
u/<level>/<E>/<N>.<hash>.{idx,pack,col}   unit files; named by their content, never changed
```

## Server rules

- Answer `Range: bytes=a-b` with status `206`. A `200` works, but then the viewer downloads a whole pack for each page.
- For other origins, send `access-control-allow-origin` with that origin or `*`.
- Use HTTP/2 or later.
- Server compression gains nothing: the unit files are compressed.

| files        | header                                               |
| ------------ | ---------------------------------------------------- |
| `u/**`       | `cache-control: public, max-age=31536000, immutable` |
| `world.json` | `cache-control: no-cache`, or a short `max-age`      |

## Publish

Upload the unit files first and `world.json` last. `narcissus publish` does this with [rclone](https://rclone.org), which you install and configure:

```sh
narcissus publish ./world remote:bucket/world --url https://example.com/world/world.json
```

It validates the folder, runs these two commands, then validates the `--url` when given. Flags after `--` go to both commands.

```sh
rclone copy ./world/u remote:bucket/world/u --immutable --header-upload "Cache-Control: public, max-age=31536000, immutable"
rclone copyto ./world/world.json remote:bucket/world/world.json --header-upload "Cache-Control: no-cache"
```

`--immutable` stops when a unit file is already there with different bytes. rclone sets the headers only on storage that keeps them, such as S3; elsewhere, set them at the server.

To replace a world, publish to the same place. Delete old unit files only after the new `world.json` is up.

## Check

```sh
narcissus validate ./world            # each file is there and well formed
narcissus validate ./world --deep     # also each file's hash, and each page decoded
narcissus validate https://example.com/world/world.json
```

For a URL, it also checks that a range from another origin gets `206` and a CORS header. `--deep` reads every byte. `narcissus info <world>` shows a world's version, CRS, extent, size, and units and splats per level.

## Show

```html
<script
	type="module"
	src="https://cdn.jsdelivr.net/npm/@kalyptos/narcissus/dist/element/index.js"
></script>
<narcissus-viewer src="https://example.com/world/world.json" style="height: 100vh">
	This browser cannot show the world.
</narcissus-viewer>
```

With a bundler, `import '@kalyptos/narcissus/element'` defines the element, in the browser only.

| attribute       | value                                                                                                    | default                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src`           | the URL of a `world.json`                                                                                |                                                                                      |
| `budget`        | the splats one frame can draw; when set, it stays fixed                                                  | 4,000,000, adapting from 2,000,000 to 6,000,000 to hold 30 FPS; 2,000,000 on a phone |
| `view-distance` | metres                                                                                                   | 4000                                                                                 |
| `camera`        | `E,N,H,yaw,pitch,distance`, read when a world opens; `E,N,,yaw,pitch,distance` looks at the ground there | the ground near the middle of the world, at yaw 0, pitch -35 and distance 300        |
| `sky`           | `r,g,b`, each 0 to 1, read when the element starts                                                       | `0.62,0.72,0.8`, a pale blue                                                         |
| `aria-label`    | the name of the canvas                                                                                   |                                                                                      |

The viewer needs WebGPU. After an error, the element shows its own content in place of the canvas, or the error message when it has none. [embedding.md](embedding.md) covers its events and API.

A content security policy must allow `worker-src blob:`. The engine caches the bytes it reads in the origin private file system.
