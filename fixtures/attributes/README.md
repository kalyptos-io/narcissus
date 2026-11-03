# Attribute fixture

A small Guldmund tree, version 2, with attribute streams. `world.json` declares `test.class` (u16, dictionary-encoded), `test.tone` (f16 × 2, plain) and `test.parts` (records, sparse).

- Two leaves: one with an `.atr`, one without (its `.idx` is version 1).
- A level 1 unit that was a root and gained a parent. Its pack keeps a level that its `.idx` no longer lists, and its `.atr` has chunks for those pages.
- Their level 2 root.
- One page has no `test.tone` chunk, so its rows take the default.

`expected.json` records what a reader must find: each unit's `.idx`, and for each `.atr` its streams and its chunks in order, with each chunk's stream, encoding, blob offset, rows, the hash of its inflated body and its decoded values. It records no bytes of the deflate streams, so `src/format/attributes.test.ts` passes whichever writer made the files.

guldmund writes the canonical fixture with its own writer, from its fixture test with `GULDMUND_FIXTURES=write`, as it writes `fixtures/tree`. guldmund checks its own output against these files byte for byte.

Until then, narcissus's own writers make a provisional one: `NARCISSUS_FIXTURES=write pnpm exec vitest --run src/format/attributes.test.ts`.
