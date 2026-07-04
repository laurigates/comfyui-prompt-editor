# comfyui-prompt-editor

Full-screen touch editor for multiline prompt widgets: weight steppers, embedding/LoRA insert palette, and a token counter.

> Part of a family of mobile-first ComfyUI usability packs — touch-friendly
> HTML modals that replace clunky native LiteGraph controls, detected by widget
> name, additive and non-clobbering. All share
> [`@laurigates/comfy-modal-kit`](https://github.com/laurigates/comfy-modal-kit)
> (the modal shell, fuzzy primitives, and the cross-pack field-provider registry
> this editor consumes). Siblings:
> [gallery-loader](https://github.com/laurigates/comfyui-gallery-loader),
> [model-gallery](https://github.com/laurigates/comfyui-model-gallery),
> [sampler-info](https://github.com/laurigates/comfyui-sampler-info),
> [touch-numeric](https://github.com/laurigates/comfyui-touch-numeric),
> [touch-connect](https://github.com/laurigates/comfyui-touch-connect),
> [touch-resize](https://github.com/laurigates/comfyui-touch-resize),
> [touch-tooltips](https://github.com/laurigates/comfyui-touch-tooltips).
>
> When a sibling provider pack (e.g. touch-numeric's seed keypad,
> sampler-info's fuzzy sampler list) is installed alongside this editor, the
> all-fields modal mounts that richer inline control per matching widget and
> falls back to its built-in control when none is registered.

![Prompt editor modal](docs/editor.png)

*The full-screen editor over any multiline prompt widget: per-token weight
steppers and a roomy textarea, committed back with Cmd/Ctrl+Enter.*

## Install

```sh
cd <ComfyUI>/custom_nodes
git clone https://github.com/laurigates/comfyui-prompt-editor
```

Restart ComfyUI; hard-refresh the browser tab (Ctrl+Shift+R / Cmd+Shift+R).

## What it does

Tapping any multiline text widget (or the appended **⤢ Edit fields** button)
opens a full-viewport, touch-first HTML modal — the all-fields node editor — in
place of the keyboard-occluded on-canvas sliver. The modal renders a control for
**every** editable widget on the node — multiline and single-line `STRING`,
`INT`/`FLOAT`, combos, and booleans — with the tapped widget focused and scrolled
above the soft keyboard.

- **Per-token weight steppers** on each multiline prompt field: ± buttons bump
  the `(token:1.1)` weight of the word under the caret without hand-typing
  parentheses.
- **Embedding / LoRA insert palette** for quickly dropping `embedding:` / `<lora:>`
  tokens into the prompt.
- **Token counter** so you can see prompt length at a glance.
- When a sibling provider pack is installed (e.g. touch-numeric's seed keypad,
  sampler-info's fuzzy sampler list), the matching field mounts that richer inline
  control and falls back to the built-in one otherwise.

Write-back is **per-field and additive**: only widgets whose value actually
changed are committed (Cmd/Ctrl+Enter or the Save button), so a cancelled edit
leaves the serialized workflow byte-for-byte unchanged. If any field fails to
write back, a copyable error popup lists the affected fields.

## Compatibility

- ComfyUI: modern Vue frontend (`comfyui-frontend-package >= 1.40`) for the
  `widget.onPointerDown` interception hook.
- Frontend changes (JS/CSS) take effect on browser hard-refresh — no restart.

## License

MIT — see `LICENSE`.
