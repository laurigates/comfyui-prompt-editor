# comfyui-prompt-editor — task runner. Run `just` (or `just --list`) for recipes.

set positional-arguments

# Show available recipes.
default:
    @just --list

##########
# Assets
##########

# Requires rsvg-convert (librsvg): `brew install librsvg` / `apt-get install librsvg2-bin`.
# pyproject [tool.comfy] Icon/Banner point at the raw GitHub PNG URLs, so the
# registry shows a broken image until you rasterize and commit the PNGs.
#
# Rasterize icon.svg + banner.svg to the PNGs the registry serves (commit them).
[group: "assets"]
assets:
    # Placeholder gate: the scaffold ships a letter-initial glyph so the SVGs are
    # valid from commit one, but no pack may PUBLISH it — pyproject already points
    # Icon/Banner at the PNGs this recipe writes, so a forgotten placeholder ships
    # a generic letter tile to registry.comfy.org (nearly happened on
    # comfyui-output-swap). Draw the bespoke pictogram, delete the marker comment.
    grep -q 'PLACEHOLDER-GLYPH' icon.svg banner.svg && { echo "icon.svg/banner.svg still carry the PLACEHOLDER-GLYPH marker — replace the letter glyph with a bespoke pictogram (family spec: #ffb02e line-art on the dark tile) and delete the marker comment before rasterizing."; exit 1; } || true
    rsvg-convert -w 400 -h 400 icon.svg -o icon.png
    rsvg-convert -w 1344 -h 576 banner.svg -o banner.png
    # Consistency gate: the family tile must trim to 346x346+27+27 on a 400x400
    # canvas. A mismatch means the icon drifted off the family spec (wrong
    # canvas size or a full-bleed tile) — see comfy-registry-lifecycle. Skipped
    # when ImageMagick's `identify` is absent (rsvg-convert is the only hard dep).
    command -v identify >/dev/null 2>&1 && { test "$(identify -format '%wx%h/%@' icon.png)" = "400x400/346x346+27+27" || { echo "icon.png off family spec (want 400x400/346x346+27+27)"; exit 1; }; } || true

##########
# Quality
##########

# Lint Python + JS/JSON (no changes).
[group: "quality"]
lint:
    uv run ruff check .
    npx @biomejs/biome check .

# Auto-format Python + JS/JSON.
[group: "quality"]
format:
    uv run ruff format .
    uv run ruff check --fix .
    npx @biomejs/biome check --write .

# Run the full test suite (pytest + Vitest) — the local CI gate.
[group: "quality"]
test:
    uv run pytest -v
    npm test

# Lint + test in one shot.
[group: "quality"]
check: lint test

##########
# Documentation artifacts
##########

# Regenerate docs/editor.png via the containerized screenshot generator.
[group: "docs"]
screenshots:
    docker build -f screenshots/Dockerfile -t comfyui-prompt-editor-screenshots .
    docker run --rm -v "$(pwd)/docs:/out" comfyui-prompt-editor-screenshots
