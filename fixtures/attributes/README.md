# Attribute fixture

A small Guldmund tree, version 2, with attribute streams. `world.json` declares `test.class` (u16, dictionary-encoded), `test.tone` (f16 × 2, plain) and `test.parts` (records, sparse).

- Two leaves: one with an `.atr`, one without (its `.idx` is version 1).
- A level 1 unit that was a root and gained a parent. Its pack keeps a level that its `.idx` no longer lists, and its `.atr` has chunks for those pages.
- Their level 2 root.
- One page has no `test.tone` chunk, so its rows take the default.

`expected.json` records what a reader must find: each unit's `.idx`, and for each `.atr` its streams and its chunks in order. For each chunk it gives the stream, encoding, blob offset, rows, the hash of the inflated body and the decoded values. It holds no deflate bytes, so `src/format/attributes.test.ts` passes whichever writer made the files.

The committed files come from guldmund. Its fixture test writes them with `GULDMUND_FIXTURES=write`, as it writes `fixtures/tree`, and guldmund checks its own output against them byte for byte. narcissus's own writers can write the same tree with `NARCISSUS_FIXTURES=write pnpm exec vitest --run src/format/attributes.test.ts`; do not commit their output.
