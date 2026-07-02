---
id: ADR-0002
date: 2026-07-02
status: Accepted
deciders: Lauri Gates
domain: api-design
supersedes: []
relates-to: [ADR-0001]
github-issues: [46]
name: consume-field-provider-registry
---

# ADR-0002: Consume the kit's cross-pack field-provider registry & click coordination

> This is the **consumer-side** mirror of `@laurigates/comfy-modal-kit`'s
> **ADR-0001** (*Cross-Pack Field-Provider Registry & Click Coordination*, kit
> v0.4.0). That ADR defines the contract; this one records `comfyui-prompt-editor`'s
> decision to depend on it. It builds on this repo's [ADR-0001](0001-adopt-typescript-bun-build.md)
> (TypeScript + bun build, kit inlined at build time).

## Decision Drivers

- **The prompt editor is the one node UI that surfaces *all* widgets at once.**
  It renders a dumb `<input type=number>` for `seed` and a dumb `<select>` for
  `sampler_name` / `ckpt_name`, even when sibling packs
  (`comfyui-touch-numeric`, `comfyui-sampler-info`, `comfyui-model-gallery`)
  are installed and each owns a far richer control for exactly those widget
  names. That richer control was reachable only by tapping the widget on the
  canvas — never from inside the editor. So the dumb control is most noticeable
  precisely here.
- **The kit now provides the contract to fix this generically.** v0.4.0 adds
  `resolveFieldProvider` / `FieldControl` (a mountable element + value
  accessors that map 1:1 onto this pack's existing `FieldRow`) and
  `patchWidgetPointer` (the uniform chain-then-consume pointer wrapper each
  pack hand-rolls). Adoption is drop-in and generic **by widget name** — no
  per-pack coupling.
- **The pack's core invariant must hold.** CLAUDE.md's "Additive only" hard
  rule: never break the built-in editor. Any provider integration has to
  degrade cleanly to the built-in control when no provider is registered.

## Considered Options

1. **Consume the kit's field-provider registry (chosen).** In `buildField`,
   call `resolveFieldProvider(widget, node)` *before* constructing the built-in
   control; on a non-null provider, mount its `FieldControl` inline and wrap it
   into the `FieldRow` shape; on null, fall through to the existing built-in
   path unchanged. Adopt `patchWidgetPointer` for the widget `onPointerDown`
   intercept.
2. **Direct pack-to-pack imports.** `prompt-editor` `bun add`s each sibling and
   calls into it. Rejected in the kit's ADR-0001: a dependency web, coupled
   release cycles, and each sibling still inlines its own kit copy (the
   modal-stacking bug persists).
3. **Open the sibling's modal nested inside the editor modal.** Rejected —
   stacks two backdrops and violates the single-active-modal invariant the kit
   exists to enforce.
4. **Do nothing.** The editor stays non-composing; the dumb controls remain.

## Decision Outcome

**Chosen: consume the kit's field-provider registry (option 1).**

- `buildField(widget, kind, node)` now takes the owning `node` (threaded from
  `openEditor`) and, as its first step, resolves a provider. A matching
  provider's `FieldControl` is wrapped into the existing `FieldRow` contract:
  `el`→`el`, `getValue()`→`read`, `hasChanged()`→`changed`, `focus?()`→`focus`,
  and `destroy?()` tracked as `_destroy`.
- The editor modal's `onClose` calls each field's `_destroy()`, so
  provider-supplied listeners/timers are torn down whether the modal closes via
  Save, Esc, or a coordinator dismiss. Built-in controls hold nothing that
  outlives the modal DOM, so they omit `_destroy`.
- On a `null` provider — or a provider whose `create()` throws — `buildField`
  falls through to the built-in `<input>`/`<select>`/toggle path **unchanged**.
  This is the additive-fallback guarantee: installing zero, one, or all sibling
  packs all work.
- The hand-rolled `onPointerDown` wrapper is replaced by `patchWidgetPointer`,
  so provider clicks and the editor's own open coordinate through the kit's
  shared runtime instead of fighting over the same handler. The version-skew
  safety net (the node-level "Edit fields" button, CLAUDE.md "Hard rules") is
  untouched.

### Positive Consequences

- The editor surfaces a sibling pack's richer inline control per field when
  present (e.g. touch-numeric's seed keypad), and degrades to the built-in
  control when absent.
- Generic by widget name; no coupling to any specific sibling pack.
- Purely additive — no serialized-workflow behavior changes.

### Negative Consequences

- Adds a runtime dependency on the kit's shared-global shape (the cross-pack
  compatibility surface stewarded in kit ADR-0001). Mitigated: the kit is
  inlined at build time and the shape is evolved additively.
- One more indirection (`resolveFieldProvider`) on the hot per-field path;
  negligible, and short-circuited to the built-in path when no providers are
  registered.

## Links

- Kit ADR-0001: `docs/blueprint/adrs/0001-cross-pack-field-provider-and-click-coordination.md` (in `comfy-modal-kit`)
- Kit onboarding (consumer section): `docs/ONBOARDING.md` (in `comfy-modal-kit`)
- This repo's [ADR-0001](0001-adopt-typescript-bun-build.md) — TypeScript + bun build, kit inlined
- Implements: [#46](https://github.com/laurigates/comfyui-prompt-editor/issues/46)
- `src/index.ts` — `buildField` (provider resolution + `FieldRow` wrap),
  `openEditor` (`onClose` teardown), `enhanceNode` (`patchWidgetPointer`)
