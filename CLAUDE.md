# CLAUDE.md

Frontend-only ComfyUI custom-node pack. `__init__.py` is a loader stub; the
extension is authored in **TypeScript** under `src/` and built to `web/dist/`
via `bun build` (see ADR-0001).

## The pattern ("the vein")

A mobile-first ComfyUI usability pack: a frontend JS extension that
intercepts a widget interaction (`widget.onPointerDown`, modern Vue
frontend) and opens a touch-friendly HTML modal in place of a clunky
native LiteGraph control. Widgets are matched **by name** (generic across
node packs), the enhancement is **additive** (graceful fallback to the
native control, never breaks serialized workflows), and the modal is
**touch-first** (16px inputs to avoid iOS zoom, big tap targets, momentum
scroll). Consumes the shared `@laurigates/comfy-modal-kit`
(`openModalShell` / `closeModalShell` / `fuzzyScore` / `fuzzyRank` /
`highlightMatches` / `ensureStyleOnce` / `appendButtonWidget`), **bundled
inline** at build time — the modal-shell + fuzzy primitives are no longer
vendored.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Empty `NODE_CLASS_MAPPINGS`; exports `WEB_DIRECTORY = "./web/dist"`. |
| `src/index.ts` | The extension (TypeScript): widget interception + modal. Build entry. |
| `src/comfyui-shims.d.ts` | Types the runtime `/scripts/app.js` import via a tsconfig `paths` shim. |
| `web/dist/index.js` | **Generated** ESM build output, but **committed** — see Hard rules. The served extension. |
| `tsconfig.json` / `knip.json` | TS strict config (`noEmit`); knip dead-code gate. |
| `pyproject.toml` | Comfy Registry metadata. `[tool.comfy] includes = ["web/dist"]`. `PublisherId` + `version` are the fields you touch. |
| `.github/workflows/` | `ci.yml` (ruff/biome/typecheck/build/pytest/vitest/gitleaks), `publish.yml` (bun build then auto-publish on version bump), `release-please.yml`. |
| `tests/` | pytest backend suite. `tests/js/` Vitest suite importing the `.ts` source + kit. |
| `justfile` | `lint`, `format`, `test`, `check` recipes — the local CI gate. |
| `docs/blueprint/adrs/` | Architecture Decision Records. |

## Build entry

The single build entry is `src/index.ts` (ComfyUI loaded the former
`web/js/prompt-editor.js`; it imported `modal-shell.js`). `bun build` bundles it
to `web/dist/index.js`: the `/scripts/app.js` runtime import is left
**external** (`--external '/scripts/*'`), and `@laurigates/comfy-modal-kit` is
bundled **inline**.

## Hard rules

- **Pack directory name is part of the URL.** `web/dist/index.js` is
  served at `/extensions/comfyui-prompt-editor/index.js`. Renaming the pack dir
  breaks every fetch. If unavoidable, sync `EXT_NAME` in `src/index.ts`.
- **No Python dependencies. The pack is frontend-only; a feature genuinely needing Python belongs in a separate companion pack.**
- **Additive only.** Never clobber an existing tooltip/control; fall back to
  the native widget when there's no match. Never fabricate data.
- **Frontend hook is version-sensitive.** The modal opens via
  `widget.onPointerDown`. Keep an explicit button-widget fallback (Strategy
  B) if you depend on the modal being reachable.
- **`web/dist/` is generated — never edit it, but always commit it.** Rebuild
  and commit it in the same commit as the source change; CI enforces that with
  `git diff --exit-code -- web/dist`. It is tracked because ComfyUI-Manager
  installs and updates over **git**, and a `git fetch && merge --ff-only`
  cannot pull an ignored path — the update reports success while ComfyUI keeps
  serving the stale bundle. Consequence: a `comfy-modal-kit` bump is a
  hand-authored PR (manifest + lockfile + rebuilt bundle together); a
  manifest-only Renovate PR fails CI by construction.

## Cross-pack integration suite

`tests/js/cross-pack-touch-numeric.test.js` loads **comfyui-touch-numeric's real
source** alongside this pack and asserts the pair through the kit's field
registry. It exists because every other suite here tests against a *synthetic*
provider (`field-bus.test.js` registers a fake one), and a real duplicate-control
defect shipped while all of them stayed green — the failure was a property of the
pair, invisible to either pack alone.

Three mechanics make it work, and all three are load-bearing:

| Piece | Why |
|---|---|
| `comfyui-touch-numeric` devDependency, pinned to a **release tag** | Tests against a published pack, not a moving branch. Bumping the tag is a deliberate, reviewable change. |
| `server.deps.inline: [/comfyui-touch-numeric/]` in `vitest.config.js` | Vitest externalizes `node_modules` by default and would hand Node raw `.ts`. |
| `openEditor` is exported | The suite drives the real build loop → `buildField` → provider resolution → `writeBack`. Testing `buildField` alone would miss the loop's own decisions, which is exactly where a duplicate control appears. |

**Assert against the real cascade.** Both packs inject stylesheets via
`ensureStyleOnce`, and jsdom resolves those rules through `getComputedStyle`.
Layout assertions must read that, not `el.style` — the declarations that caused
the scroll-trapping bug live in class rules, so an inline-style check is vacuous
and passes against the bug.

**Verify a new assertion has teeth**: pin the devDependency back to the release
*before* the fix, confirm the test goes red for the right reason, then restore
the pin. An integration test that has never failed has not been shown to test
anything.

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
bun install                  # TypeScript, Vitest, Biome, knip, comfy-modal-kit
pre-commit install
bun run typecheck            # tsc --noEmit (the type gate)
bun run build                # emit web/dist/index.js (kit inlined, /scripts/* external)
bun run test                 # Vitest
bun run lint                 # biome check
bun run knip                 # dead-code gate
```

The served file is `web/dist/index.js` (the build output), **not** the source.
After editing `src/`, run `bun run build`, then hard-refresh the tab — no
ComfyUI restart needed.


### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-prompt-editor/index.js
```

## Releases

Bump `version` in `pyproject.toml` and push to `main` →
`publish.yml` runs `bun install && bun run build` then
`Comfy-Org/publish-node-action` publishes to the Comfy Registry (the built
`web/dist/` is force-shipped via `[tool.comfy] includes`). Requires the
`REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits; release-please
maintains `CHANGELOG.md` and the version bump PR.

## Architecture Decision Records

| ADR | Status | Decision |
|-----|--------|----------|
| [0001](docs/blueprint/adrs/0001-adopt-typescript-bun-build.md) | Accepted | TypeScript source built to `web/dist/` via `bun build`; consume `@laurigates/comfy-modal-kit` inline. Supersedes the prior (CLAUDE.md-documented) vanilla-JS + vendored-primitives architecture. |
| [0002](docs/blueprint/adrs/0002-consume-field-provider-registry.md) | Accepted | Consume the kit's cross-pack field-provider registry (`resolveFieldProvider` / `FieldControl`) and `patchWidgetPointer`, so the editor mounts a sibling pack's richer inline control per field, with additive fallback to the built-in control. Consumer mirror of kit ADR-0001. |
| [0003](docs/blueprint/adrs/0003-lora-row-model-picker-and-row-management.md) | Accepted | rgthree Power Lora Loader rows: consume the kit's **category-keyed** `ModelPicker` for the filename (in-shell overlay + host-owned scroll wrapper), add in-modal row management (↑/↓/⨯/➕) as plain `node.widgets` splices applied immediately after a flush, derive dual-strength from rgthree's `Show Strengths` property, and make the entry-point button's idempotency presence-based so `configure()`'s widget wipe can't strand it. Consumer mirror of kit ADR-0003. |
