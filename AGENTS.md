# Weather Scrape project instructions

## Purpose

This repository produces auditable municipality/city rainfall estimates for the Philippines from CHIRPS v3, starting with a location list matched to official PSGC codes.

## Data rules

- Treat the municipal/city PSGC as a 10-character text identifier. Never coerce it to a number or drop a leading zero.
- Match locations using the reference `city_municipality_code` and retain the matched municipality/city and province beside each result.
- A province-only input must remain unmatched for a municipality/city workflow; do not silently substitute a provincial code.
- Query the GeoRiskPH municipal layer by `psgc_10d` only after validating that the returned feature has the expected name and province.
- Use CHIRPS v3 Final by default. Record the product (`rnl` or `sat`), date, exact raster URL, grid-cell contributions, coverage, and calculation method in every output.
- Rainfall is a modelled estimate in millimetres, not a gauge observation. Label derived cubic-metre figures as estimated precipitation volume.

## Project hygiene

- The repo runs in two modes; scripts auto-resolve packages, never hardcode one mode:
  - **Codex** — set `WEATHER_SCRAPE_NODE_MODULES` to the runtime package directory returned by the workspace-dependency loader (supplies `@oai/artifact-tool`-era spreadsheet/image packages or the local fallbacks below). Do not commit a `node_modules` link.
  - **Standalone (any machine)** — `npm install` to get `sharp` and `exceljs`, then omit `WEATHER_SCRAPE_NODE_MODULES`. `src/lib/runtime.mjs` falls back to the local `node_modules` automatically.
- Do not reintroduce imports of Codex-only packages (`@oai/artifact-tool`) into `src/`; `exceljs` and `sharp` are the portable equivalents. If a Codex session offers a bundled package, it may be used via `requireWorkspacePackage` but the code must keep working without it.
- Keep raw source files, downloaded rasters, and disposable caches out of Git. Preserve user inputs unchanged and write new files to `outputs/`.
- Do not add secrets, cookies, API tokens, or downloaded raw CHIRPS rasters to the repository.
- Update `docs/METHODOLOGY.md` whenever the matching, boundary, rainfall product, area calculation, or volume formula changes.
- Before claiming a generated workbook is valid, verify PSGC codes are 10-character text, inspect sample matches, scan formula errors, and render a preview.

## Public distribution

Publish source, generic documentation and synthetic fixtures only. Working inputs, outputs, captured websites and analysis caches stay local and ignored. No prior private run evidence is bundled.
