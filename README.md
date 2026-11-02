# narcissus

[![npm](https://img.shields.io/npm/v/@kalyptos/narcissus)](https://www.npmjs.com/package/@kalyptos/narcissus)
[![build](https://img.shields.io/github/actions/workflow/status/kalyptos-io/narcissus/build.yml?branch=main)](https://github.com/kalyptos-io/narcissus/actions/workflows/build.yml)
[![license](https://img.shields.io/npm/l/@kalyptos/narcissus)](LICENSE)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@kalyptos/narcissus)](https://www.npmjs.com/package/@kalyptos/narcissus)

The open library for Guldmund Trees: gaussian-splat scenes of any size, as static files streamed by range request. It holds the format, a WebGPU engine, a viewer element, and tools that check and publish a world.

## Show a world

```html
<script
	type="module"
	src="https://cdn.jsdelivr.net/npm/@kalyptos/narcissus/dist/element/index.js"
></script>
<narcissus-viewer
	src="https://example.com/world/world.json"
	style="height: 100vh"
></narcissus-viewer>
```

Or with a bundler:

```sh
npm install @kalyptos/narcissus
```

```ts
import { createEngine, Controls } from '@kalyptos/narcissus';
```

## Check and publish a world

```sh
npx @kalyptos/narcissus validate ./world --deep
npx @kalyptos/narcissus info ./world
npx @kalyptos/narcissus export ./world -o level3.ply --level 3
npx @kalyptos/narcissus publish ./world remote:bucket/world
```

## Read more

- [docs/format.md](docs/format.md): the format
- [docs/hosting.md](docs/hosting.md): serve, publish and show a world
- [docs/embedding.md](docs/embedding.md) and [examples/hooks.html](examples/hooks.html): layers, masks, picking, lines, markers and the camera
- [docs/architecture.md](docs/architecture.md): the code, sources and plugins
- [CONTRIBUTING.md](CONTRIBUTING.md)

## Licence

[BSD-3-Clause](LICENSE).
