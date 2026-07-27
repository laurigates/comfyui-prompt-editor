---
id: ADR-0003
date: 2026-07-27
status: Accepted
deciders: Lauri Gates
domain: api-design
relates-to: [ADR-0002]
github-issues: []
name: lora-row-model-picker-and-row-management
---

# ADR-0003: LoRA Rows — Consume the Model-Picker Registry, and Manage Rows In-Modal

Consumer mirror of **comfy-modal-kit ADR-0003**.

## Context

The editor already renders one card per rgthree Power Lora Loader row, but three
things were still unusable on touch — the whole point of this pack:

1. **The filename was a bare `<input type="text">`.** Typing a `folder_paths`
   model path by hand on a phone. comfyui-model-gallery *has* a card grid for
   exactly this, but its `FieldProvider` never engages: it matches on *"widget
   name is in `WIDGET_CATEGORY` AND the widget carries `options.values`"*, and a
   LoRA row is a `type: "custom"` widget named `lora_3` whose value is an object —
   failing both halves.
2. **Add / remove / reorder were unreachable.** rgthree gates remove and reorder
   behind a right-click context menu, and `➕ Add Lora` behind a LiteGraph menu.
3. **The on-canvas path is not an alternative.** rgthree custom widgets route
   pointer input through `mouse()` / `onMouseDown` plus a `hitAreas` table
   (`utils_widgets.ts`), **not** `onPointerDown` — which is what the kit's
   `patchWidgetPointer` wraps. It can never fire on a LoRA row. This modal is the
   only practical surface.

## Decision Outcome

### 1. Consume the kit's category-keyed `ModelPicker`

`resolveModelPicker("loras")` → mount the control in an `openShellOverlay`
(single-modal discipline: a second `openModalShell` would dismiss this one).
Cancel / Esc / backdrop leave the row untouched; **Choose starts disabled** and
enables on the first selection, so confirming can never commit a file the user
did not pick.

**The host obligation that would otherwise break this silently:**
`.cmp-ov-card` is a `max-height`-capped `display: flex` column with **no scroll
region of its own**, while a `ModelPickerControl.el` is contractually *not* a
scroll container. So the host wraps the mounted element in its own
`flex: 1; min-height: 0; overflow-y: auto` div — `.pe-pick-scroll`. Without it
the grid is clipped and every file below the fold is unreachable; without
`min-height: 0` the flex item's default `min-height: auto` refuses to shrink and
blows past the card's max-height. Both are pinned by a jsdom test.

**Additive fallback, unchanged contract:** no picker registered (model-gallery not
installed) → the text input renders exactly as before. Same shape as
`resolveFieldProvider`. The pack's whole existing LoRA test suite passes
untouched, which is the proof.

`createSummary` mounts under the filename button when the provider offers one. Its
DOM is provider-owned and never inspected here — all metadata knowledge stays in
model-gallery. A `createSummary` that throws is caught: the strip is decoration.

### 2. Row management as plain `node.widgets` splices

`↑ / ↓ / ⨯` per row and a node-level `➕ Add LoRA`. rgthree's own menu handlers
are plain array operations (`removeArrayItem` / `moveArrayItem`), so we do
exactly what they do — `node.widgets` order **is** `widgets_values` order, which
is what makes reordering meaningful.

Detection stays **shape-based** (`isLoraWidgetValue`), matching this pack's
existing classifier, rather than rgthree's name-based `startsWith("lora_")`, so a
fork that renames rows still reorders correctly. Reordering steps *over*
rgthree's interleaved divider / header / spacer / button widgets, which is
identical to rgthree's raw-adjacent-index behaviour in the contiguous case it
actually produces, and correct in the case it doesn't.

`➕ Add LoRA` calls `addNewLoraWidget(chosen)`. TypeScript `private` erases at
compile time, so it is a plain prototype method on the shipped
`web/comfyui/power_lora_loader.js` — but it is still rgthree's internal API, so
every entry point sits behind `canAddLoraRow()`. A refactor upstream degrades to a
missing button, never a throw. The affordances are also withheld when the host
supplies no `rebuild` hook: an entry point that cannot complete its own action is
worse than an absent one.

### 3. Structural edits apply immediately — and flush first

**The wrinkle:** the modal's contract is "nothing is written until Save", but a
structural op changes the field list the modal is *rendering*, so it must apply
and re-render immediately. Cancel therefore will not undo an add / remove /
reorder. The alternative — staging structural edits in a shadow row list and
applying on Save — is substantially more code for a case where "the row is gone"
is the obvious reading of tapping ⨯.

**Chosen: apply immediately, labelled** ("Row changes apply immediately (and save
pending edits)").

But applying immediately introduces a second, worse hazard that the naive version
has: rebuilding re-reads every field from `node.widgets`, so a prompt the user had
just typed into an unrelated textarea would be **silently discarded** by tapping ⨯
on a LoRA row. So `rebuild()` **flushes first** — `commit()`'s write-back loop was
extracted to `writeBack()` and runs before the mutation. Nothing typed is ever
lost; the whole modal simply becomes applied at that point, which is consistent
with what the label promises.

`rebuild()` mutates `fields` **in place** (`fields.length = 0`), never reassigns
it: the sibling-field bus closes over that array by reference, and a reassignment
would leave the bus pointing at the old list.

### 4. Two correctness fixes taken while in here

- **Dual-strength mode now derives from rgthree's node property**
  `properties["Show Strengths"] === "Separate Model & Clip"` — what
  `PowerLoraLoaderWidget.draw()` itself reads — rather than only
  `strengthTwo != null`. A row's `strengthTwo` merely reflects the last draw, so
  it is still `null` on a row switched to separate mode but not yet redrawn; the
  old derivation hid the CLIP strength on exactly those rows. Falls back to the
  value shape when the node carries no such property.
- **rgthree's `"None"` sentinel is treated as empty for display.** Its own chooser
  prepends a literal `"None"` entry that the backend `get_lora_by_filename`
  cannot resolve. It is **not** normalised on write-back: rewriting an untouched
  row's `"None"` to `""` would churn `widgets_values` on a row the user never
  touched. Pinned by a round-trip test.

### 5. The entry-point button's idempotency is now by presence

Confirmed, not hypothesised: rgthree's `configure()` runs
`while (this.widgets?.length) this.removeWidget(0)`, and `configure()` runs
**after** `nodeCreated` on a loaded graph. With the old once-per-node boolean
stamp the sequence was: `nodeCreated` adds `⤢ Edit fields` and stamps →
`configure()` deletes it → `loadedGraphNode` sees the stamp and skips → **the
editor was unreachable on every LOADED Power Lora Loader**, while working fine on
a freshly dropped one. Idempotency is now `hasEditButton(node)` — is the widget
still there. (The pointer-patch guard was already stamped on the *widget*, so it
was already immune; that is now noted where it is declared.)

A mutation check found this had **no** test coverage, so a regression guard was
added that drives `enhanceNode` through the wipe sequence. Reinstating the boolean
stamp fails exactly that test.

## Consequences

- Positive: the reported symptom (hand-typing model paths) is gone, and the three
  context-menu-only operations become touch-reachable, with no change to the
  on-canvas rendering (deliberately untouched — see context item 3).
- Positive: the editor is now reachable on loaded Power Lora Loaders at all.
- Negative: Cancel does not undo structural row edits. Labelled in the UI and in
  the README.
- Negative: `buildField` gains a fifth (optional) parameter. Callers that omit it
  — the unit tests, any future single-field host — get the previous behaviour
  exactly, which is what keeps the existing suite green.
- Negative: `addNewLoraWidget` is rgthree-internal. Behind a capability probe, so
  the failure mode is a missing button.

## Dependency

`@laurigates/comfy-modal-kit` `^0.7.0` → `^0.8.0` for `registerModelPicker` /
`resolveModelPicker`.

## Links

- comfy-modal-kit ADR-0003 — the registry and why it is separate from
  `FieldProvider`.
- comfyui-model-gallery ADR-0003 — the provider side.
- [ADR-0002](0002-consume-field-provider-registry.md) — the widget-keyed
  provider consumption this sits beside.
