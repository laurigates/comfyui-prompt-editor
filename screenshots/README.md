# README screenshot pipeline

Containerized [Playwright](https://playwright.dev) + ComfyUI generator that
regenerates the README screenshot (`docs/editor.png`) reproducibly, so the
shot doesn't depend on whatever theme/frontend a particular dev machine
happens to have.

## Run

From the repo root:

```sh
just screenshots
```

First build is ~4 min (clones ComfyUI, installs CPU torch + ComfyUI deps,
pulls the npm driver dep on top of the pre-baked Chromium). Cached rebuilds
are ~30s. The PNG lands at `docs/editor.png`.

## How it works

1. `Dockerfile` builds on the official Playwright image (Node 22 + Chromium
   pre-installed), clones a pinned ComfyUI release, and installs CPU-only
   torch + ComfyUI's requirements.
2. `entrypoint.sh` launches ComfyUI headless on `:8188` (`--cpu`), waits for
   `/system_stats`, then runs the capture driver.
3. `capture.mjs` (Playwright) loads `workflow.json` (a single CLIPTextEncode
   with a sample prompt), opens the editor over its multiline `text` widget
   (Strategy A `widget.onPointerDown`, falling back to the explicit `⤢`
   expand button), and screenshots the `.cmp-dialog`.
4. The driver writes to `/out`, which the `just` recipe mounts to `docs/`.

| File | Purpose |
|------|---------|
| `Dockerfile` | Single-stage build (Playwright base + ComfyUI + CPU torch). |
| `Dockerfile.dockerignore` | Keeps the build context lean. |
| `entrypoint.sh` | Boots ComfyUI, waits for ready, runs the driver, asserts `$EXPECTED_OUTPUTS` exist. |
| `capture.mjs` | Playwright driver — opens the prompt editor and shoots it. |
| `workflow.json` | Single-CLIPTextEncode graph (with a sample prompt) the driver loads. |
| `package.json` | Pins the Playwright npm version for the driver. |

## Pins (bump deliberately)

- **`ARG COMFYUI_REF`** (`Dockerfile`) — the ComfyUI release. The modal is
  rendered by the frontend bundle that ships with this release; `v0.22.0`
  ships `comfyui-frontend-package==1.43.18`, clearing the pack's `>=1.40`
  floor (the `widget.onPointerDown` hook).
- **Playwright version** — pinned in BOTH `Dockerfile` (`FROM
  mcr.microsoft.com/playwright:v1.49.1-noble`) and `package.json`. Keep them
  in lockstep: the base-image tag pins the Chromium revision (the largest
  source of cross-host font-rendering drift) and the npm dep is the driver
  API. Bump both together.

## Don't hand-edit `docs/editor.png`

It's generated. To change it, edit `capture.mjs` / `workflow.json` and
re-run `just screenshots`.
