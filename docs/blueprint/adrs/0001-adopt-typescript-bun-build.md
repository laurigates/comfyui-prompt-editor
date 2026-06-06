---
id: ADR-0001
date: 2026-06-06
status: Accepted
deciders: Lauri Gates
domain: build-tooling
supersedes: []
relates-to: []
github-issues: []
name: blueprint-derive-adr
---

# ADR-0001: Adopt TypeScript + bun build, consume @laurigates/comfy-modal-kit

> **Note on superseded decisions.** This pack had no prior `docs/blueprint/adrs/`
> ADRs. The previous architecture was documented only in `CLAUDE.md`: a
> **single-file / few-file vanilla-JS** pack served straight from `web/js/`,
> with the modal-shell and fuzzy primitives **vendored** (copied from
> gallery-loader). This ADR records the decision to **supersede that
> CLAUDE.md-documented vanilla-JS + vendored-primitives architecture** with a
> typed, built source that consumes the shared kit. The mirror of this decision
> in the sibling pack is comfyui-sampler-info's ADR-0010.

## Decision Drivers

- The vanilla-JS implementation had **no static type checking**. The pack
  reaches deep into the minified ComfyUI frontend's LiteGraph widget/node
  objects (`widget.onPointerDown`, `widget.callback`, `node.widgets`,
  `node.addWidget`, `app.graph._nodes`, `app.canvas`). Those accesses are
  exactly where a frontend-version bump silently breaks the pack (see the
  "Frontend hook is version-sensitive" hard rule). Type checking against
  `@comfyorg/comfyui-frontend-types` turns a class of those breakages into
  compile errors.
- The modal-shell + fuzzy primitives were **vendored** — copied verbatim into
  `web/js/modal-shell.js` and `web/js/modal-fuzzy.js` from gallery-loader.
  Three packs (gallery-loader, sampler-info, this one) carried byte-identical
  copies that drifted independently. Extracting them into a single published
  package (`@laurigates/comfy-modal-kit`) and **inlining** it at build time
  removes the duplication while keeping the runtime contract (a single
  self-contained ESM file, no extra fetch).
- A bun-externalization spike confirmed the toolchain keeps the
  zero-extra-runtime-fetch property: `bun build ./src/index.ts --target browser
  --format esm --outdir web/dist --external '/scripts/*'` emits browser-clean
  ESM with the `/scripts/app.js` runtime import left **unbundled** (resolved at
  runtime against ComfyUI's served module) and the kit **bundled inline** (not
  externalized — the consumer ships one file).

## Considered Options

1. **TypeScript source in `src/`, built to `web/dist/` via `bun build`,
   consuming the kit inline** — typed authoring, browser-ESM output,
   `/scripts/*` externalized, kit inlined.
2. **Stay on vanilla JS with vendored primitives (status quo)** — no build, no
   types, three drifting copies of the modal primitives.
3. **TypeScript with `tsc` emit instead of `bun build`** — `tsc` can emit ESM,
   but does not understand the `--external '/scripts/*'` runtime-import concept,
   nor does it bundle the kit into one file; it is a type checker first, a
   bundler never.
4. **Externalize the kit at runtime** (a separate companion pack served at
   `/extensions/comfyui-modal-kit/...`) — avoids inlining but adds a second
   pack the user must install and a second network fetch; rejected for a v0.1
   single-pack distribution.

## Decision Outcome

**Chosen option**: "TypeScript source in `src/`, built to `web/dist/` via
`bun build`, consuming the kit inline". The spike proved the output preserves
the runtime contract, the type checker pays for itself at the frontend seam,
and inlining the kit collapses three vendored copies to one published source.
`tsc --noEmit` is the type gate; `bun build` is the emit. The two are
decoupled — `tsc` never emits, `bun` never type-checks — keeping each fast and
single-purpose.

### Build & serve mechanics

- **Source**: `src/index.ts` (the port of the former
  `web/js/prompt-editor.js`) plus `src/comfyui-shims.d.ts`.
- **Type gate**: `bun run typecheck` → `tsc --noEmit` against
  `@comfyorg/comfyui-frontend-types` (dev dependency).
- **Emit**: `bun run build` → `bun build ./src/index.ts --target browser
  --format esm --outdir web/dist --external '/scripts/*'`. This pack has no
  `web/data/` corpus, so there is no `cp -R web/data web/dist/data` step.
- **Kit**: `@laurigates/comfy-modal-kit` is a runtime `dependency` and is
  **bundled inline** into `web/dist/index.js` (NOT in `--external`). The
  consumer ships a single self-contained ESM file; no second fetch, no second
  pack to install.
- **Serve**: `__init__.py` sets `WEB_DIRECTORY = "./web/dist"`. ComfyUI serves
  that tree at `/extensions/comfyui-prompt-editor/`, so the built JS is at
  `/extensions/comfyui-prompt-editor/index.js`. `EXT_NAME` is unchanged — the
  served path still derives from the pack directory name, not the JS file
  location.
- **Distribution**: `web/dist/` is git-ignored (generated). The Comfy Registry
  tarball includes it via `[tool.comfy] includes = ["web/dist"]`, and CI
  (`publish.yml`) runs `bun install && bun run build` before
  `publish-node-action` so the artifact exists at publish time.

### Type-seam notes (for future maintainers)

- `@comfyorg/comfyui-frontend-types` exports `ComfyApp` at the module root, but
  **not** `LGraphNode` / `LGraphCanvas` / the widget interfaces (declared
  internally, un-exported). The pack models the small surface it touches with
  local structural interfaces (`PromptWidget`, `PromptNode`) rather than
  importing un-exportable types.
- TypeScript will not match an ambient `declare module` against a rooted
  (`/scripts/app.js`) path specifier. A `paths` mapping in `tsconfig.json`
  points that import at `src/comfyui-shims.d.ts` for type resolution; the
  emitted import string stays `/scripts/app.js` and `--external '/scripts/*'`
  keeps it unbundled.
- The kit preserves the original export names (`openModalShell`,
  `closeModalShell`, `fuzzyScore`, `fuzzyRank`, `highlightMatches`), so call
  sites that used the vendored `modal-shell.js` need no renames — only the
  import specifier changes to `@laurigates/comfy-modal-kit`.

### Positive Consequences

- Static type checking at the version-sensitive frontend seam — the single
  largest source of silent breakage now has a compile-time gate.
- The vendored modal-shell + fuzzy copies are gone; the shared primitives live
  in one published package and are inlined at build time.
- Output is still plain browser ESM served as a static file; no runtime
  bundler, no framework, no change to how ComfyUI loads the extension, no extra
  fetch.
- The pure functions keep their exact export names (`bumpWeight`,
  `isMultilineStringWidget`, `isTargetWidget`, `TARGET_WIDGET_NAMES`), so the
  Vitest suite imports the `.ts` source directly; the fuzzy primitive is now
  imported from the kit in the test.
- `knip` + `tsc` + Vitest + Biome give a complete local gate chain.

### Negative Consequences

- The "edit → hard-refresh" loop now requires a `bun run build` step (the
  served file is `web/dist/index.js`, not the source). Mitigated by `just
  build` and a fast (~3ms) incremental build.
- A build artifact must be present for the registry publish; CI builds first,
  but a fresh checkout has no `web/dist/` until `bun run build` runs.
- One more dev dependency set (`typescript`,
  `@comfyorg/comfyui-frontend-types`, `knip`, `@biomejs/biome`) plus the kit
  runtime dependency, and a `tsconfig.json` to maintain.

## Pros and Cons of Options

### TypeScript + bun build, kit inlined

- ✅ Static types at the frontend seam
- ✅ Browser-ESM output preserves the runtime contract (spike-confirmed)
- ✅ Single shared source for the modal primitives; no vendored drift
- ✅ Decoupled type gate (`tsc --noEmit`) and emit (`bun build`)
- ❌ Adds a build step to the edit-refresh loop
- ❌ Generated artifact must be built before publish

### Stay on vanilla JS with vendored primitives

- ✅ Zero build toolchain
- ❌ No type safety at the exact place breakage happens
- ❌ Three drifting copies of modal-shell / modal-fuzzy

### TypeScript with `tsc` emit

- ✅ Single tool for typecheck + emit
- ❌ `tsc` is not a bundler; `--external '/scripts/*'` and kit-inlining are
  bundler features

### Externalize the kit at runtime

- ✅ No inlining; one source of the kit at runtime
- ❌ Second pack to install + second network fetch; rejected for single-pack v0.1

## Links

- Bun build: `bun build ./src/index.ts --target browser --format esm --outdir
  web/dist --external '/scripts/*'` (kit inlined, `/scripts/*` external)
- `CLAUDE.md` § "File layout", § "Dev workflow"
- Sibling decision: comfyui-sampler-info ADR-0010 (TypeScript + bun build)
- `@laurigates/comfy-modal-kit` — the extracted shared modal-shell + fuzzy
  primitives, consumed in place of the former vendored `web/js/modal-shell.js`
  and `web/js/modal-fuzzy.js`

---
*Authored as part of the TypeScript + bun build migration.*
