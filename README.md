# narcissus

[![npm](https://img.shields.io/npm/v/@kalyptos/narcissus)](https://www.npmjs.com/package/@kalyptos/narcissus)
[![build](https://img.shields.io/github/actions/workflow/status/kalyptos-io/narcissus/build.yml?branch=main)](https://github.com/kalyptos-io/narcissus/actions/workflows/build.yml)
[![license](https://img.shields.io/npm/l/@kalyptos/narcissus)](LICENSE)
[![unpacked size](https://img.shields.io/npm/unpacked-size/@kalyptos/narcissus)](https://www.npmjs.com/package/@kalyptos/narcissus)

The open library for Guldmund Trees: gaussian-splat scenes of any size, stored as static files and streamed by range request. narcissus holds the format, a WebGPU engine that draws it, a viewer element, and tools to check and publish a world.

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

- [docs/format.md](docs/format.md): the specification of Guldmund Trees
- [docs/hosting.md](docs/hosting.md): how to serve, publish and show a world
- [docs/embedding.md](docs/embedding.md): the hooks for a page that embeds the viewer: layers, masks, picking, graphics and the camera
- [docs/architecture.md](docs/architecture.md): how the code is built, and how to add a source or a plugin
- [CONTRIBUTING.md](CONTRIBUTING.md)

## Licence

[BSD-3-Clause](LICENSE).
