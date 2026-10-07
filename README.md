# Philippines municipal rainfall

This project turns a branch/location list into an auditable municipality/city precipitation-volume dataset.

The workflow has two explicit stages:

1. Match every municipality/city to the official 10-digit PSGC code.
2. Overlay the official municipal boundary against CHIRPS v3 daily grids, then calculate estimated rainfall volume.

It deliberately keeps source inputs unchanged and writes generated files under `outputs/`.

## Runtime setup

Install the two dependencies locally (Node >= 20):

```bash
npm install
```

The scripts resolve `sharp` and `exceljs` from the local `node_modules`. In Codex you can instead set `WEATHER_SCRAPE_NODE_MODULES` to the bundled package directory and skip the install. No `node_modules` directory is committed.

## 1. Attach municipal/city PSGC codes

```bash
npm run attach-psgc -- \
  --locations "/path/to/locations.xlsx" \
  --psgc-reference "/path/to/philippines_psgc_barangays.csv" \
  --output "outputs/locations_with_municipal_city_psgc_10d.xlsx"
```

The location workbook must include `Matched PSGC Location`. The output adds the following audit fields:

- `Municipality/City PSGC 10d`
- `PSGC Matched Municipality/City`
- `PSGC Matched Province`
- `PSGC Match Status`

## 2. Create an August daily rainfall-volume CSV

Single municipality:

```bash
npm run chirps-volume -- \
  --psgc 0305402000 \
  --year 2025 \
  --month 8 \
  --output "outputs/apalit_pampanga_chirps_v3_2025-08.csv"
```

All municipalities in a matched locations workbook (one CSV, one row per municipality-day; daily rasters are downloaded once and reused across all municipalities; downloads are cached under `data/cache/`):

```bash
npm run chirps-batch -- \
  --locations "Branches_psgc.xlsx" \
  --year 2025 \
  --month 8 \
  --output "outputs/branches_chirps_v3_2025-08.csv"
```

Append `--day 1` to either command for a one-day smoke test. Batch also accepts `--limit <n>` to process the first n municipalities, `--psgc <code,code,...>` to restrict the run to specific PSGCs, `--month-end <1-12>` for an inclusive month range, and `--refresh-boundaries` to re-query GeoRiskPH instead of the local boundary cache. Point `--output` at an `.xlsx` path to get a styled workbook with live volume formulas instead of a CSV.

Both commands query the GeoRiskPH municipal layer for the boundary, retrieve the CHIRPS v3 Final `rnl` daily rasters, and produce a CSV with daily source URLs, intersected grid cells, overlap areas, rainfall depth, and an Excel-ready volume formula.

Read [the methodology](docs/METHODOLOGY.md) before interpreting the results. The results are rainfall estimates, not station-gauge measurements.

See [validation guidance](docs/VALIDATION.md) for local checks.

## Source-only public copy

Fresh history; operational location workbooks, rainfall exports, captured website pages, API-key-bearing HTML and private local paths are excluded. Generate outputs with your own local inputs.
