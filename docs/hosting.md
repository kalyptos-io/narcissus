# Hosting a world

A world is a folder of static files. Any server or object store that answers range requests can serve it; there is no server software to run.

```
world.json                              the manifest; small, replaced when the world changes
u/<level>/<E>/<N>.<hash>.{idx,pack,col}   unit files; named by their content, never changed
```

[format.md](format.md) is the specification of these files.

## What the server must do

- **Answer range requests.** The viewer reads pages out of the `.pack` files with `Range: bytes=a-b` and expects status `206`. A server that answers `200` with the whole file still works, but the viewer then downloads a whole pack for each page it reads.
- **Send CORS headers** when the page that shows the world is on another origin: `access-control-allow-origin` with that origin or `*`.
- **Speak HTTP/2 or later.** A view makes many small requests.

The unit files are compressed already, so compression at the server gains nothing.

## Cache headers

| files        | header                                               | why                                                    |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| `u/**`       | `cache-control: public, max-age=31536000, immutable` | a unit file never changes under its name               |
| `world.json` | `cache-control: no-cache`                            | it names the current unit files, so it must stay fresh |

A short `max-age` on `world.json` is also possible, when a CDN in front must not ask the origin on each load.

## Publish

Upload the unit files first and `world.json` last. A viewer then never reads a manifest that names files which are not there yet.

`narcissus publish` does this with [rclone](https://rclone.org), which you install and configure for your storage yourself:

```sh
narcissus publish ./world remote:bucket/world --url https://example.com/world/world.json
```

It checks the folder, runs the two commands below, and then checks the URL when you give one. Flags after `--` go to both rclone commands.

```sh
rclone copy ./world/u remote:bucket/world/u --immutable --header-upload "Cache-Control: public, max-age=31536000, immutable"
rclone copyto ./world/world.json remote:bucket/world/world.json --header-upload "Cache-Control: no-cache"
```

`--immutable` makes rclone stop when a unit file is there already with other bytes. rclone sets the upload headers only on the storage types that keep them, such as S3 and the stores compatible with it; on the others, set the cache headers at the server.

To replace a world, publish the new folder to the same place. The unit files that both worlds hold are not sent again. Viewers that are open keep the old manifest; they read the new one when they meet a file that is gone, so delete the old unit files only after the new `world.json` is up.

## Check

```sh
narcissus validate ./world            # each file is there and well formed
narcissus validate ./world --deep     # also each file's hash, and each page decoded
narcissus validate https://example.com/world/world.json
```

For a URL it also asks the server for a range from another origin, and reports a server that does not answer with `206` or sends no CORS header. A deep check reads every byte of the world.

`narcissus info <world>` shows the size and the levels of a world.

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

The viewer needs WebGPU. The content of the element shows when the browser has none, or when the world does not load.

With a bundler, `import '@kalyptos/narcissus/element'` defines the element. Import it in the browser only; a server that renders the page has no DOM for it.

| attribute       | value                                                                                                                    | default                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `src`           | the URL of a `world.json`                                                                                                |                                                                                               |
| `budget`        | the splats one frame may draw; set, it stays fixed                                                                       | from 4,000,000, adapting between 2,000,000 and 6,000,000 to hold 30 FPS; 2,000,000 on a phone |
| `view-distance` | metres                                                                                                                   | 4000                                                                                          |
| `camera`        | the view to open on: `E,N,H,yaw,pitch,distance`; with `H` empty, `E,N,,yaw,pitch,distance`, it looks at the ground there | above the middle of the world, looking at its ground                                          |
| `sky`           | the colour behind the world: `r,g,b`, each 0 to 1                                                                        | a pale blue                                                                                   |

The element sends a `ready` event when a world is open and an `error` event with a message when it cannot go on. Its `engine` and `controls` properties give the page the full API; [embedding.md](embedding.md) shows how to add splats, hide parts of the world, pick and steer the camera.

A page with a content security policy must allow `worker-src blob:`, because the engine starts its workers from a blob. The engine keeps the bytes it has read in the browser's origin private file system, so a second visit reads less from the network.
