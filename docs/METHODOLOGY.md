# Methodology — full audit reference

This document explains, end to end and in reproducible detail, how every rainfall figure in this repository is produced: where the numbers come from, how they are computed, every intermediate artifact, and — just as important — what the numbers are **not**, and where they can and cannot be trusted. Anyone auditing a row in any output file should be able to re-derive it from this document plus the cited public sources.

## 0. Products this repo produces

| Output | Granularity | File(s) |
|---|---|---|
| Branch rainfall, series | one row per branch × day (2018-01-01 → latest Final) | `outputs/branches_chirps_v3_rnl_daily_YYYY.csv`, canon at `work/daily/municipality_daily.csv` |
| Branch rainfall, series | one row per branch × month | `outputs/branches_chirps_v3_rnl_monthly_YYYY-MM.csv` |
| PAGASA CliMap baseline + CHIRPS comparison | one row per branch × calendar month | `outputs/branches_pagasa_climap_baseline_and_chirps.csv` |

All figures describe the same underlying estimate: precipitation **falling over the municipality's mapped area**, derived from CHIRPS v3 Final. "Branches" are not the unit of estimation — the municipality is. Every branch sharing a municipality carries the identical municipality-level value, with `branches_in_municipality` recording how many branches are covered by the row. See §7 for why this is the honest unit.

## 1. PSGC matching

Branch location names come from the input workbook (e.g. `branches_psgc`), which names each branch plus a free-text matched location like `Apalit, Pampanga`. These are mapped to official **PSGC** (Philippine Standard Geographic Code) municipality/city codes.

- The PSGC reference is reduced to one unique municipality/city row per `city_municipality_code`. A location is matched by normalized municipality/city name and province. `City of`, punctuation, capitalization, and common `Sto.` variations are normalized only for comparison; the reference label is preserved in the output.
- If a parenthetical location specifies a city, the matcher prefers a city-type reference record. If multiple places have the same name, the province from the matched location takes priority; a province present in the branch label can break a remaining tie.
- Province-only inputs (e.g. `Abra`, `Antique`) are reported with status `Province-only input — no municipality/city PSGC` and are **deliberately excluded** from all rainfall outputs. A province's area is not a municipality's rainfall, and guessing one municipality inside it would be fabrication.
- **The output code is a 10-character text value, never a number, never coerced.** Leading zeros (`0105508000`, Abulug Cagayan) are significant and are preserved in every CSV, workbook, and JSON. Silent numeric coercion would drop the zero and mis-key every downstream join.

Because branch files often contain duplicates (the same municipality hosting several branches — Quezon City has 22 in the current file, 367 branch rows reduce to 234 unique municipalities), `work/branch_cell_index.json` stores municipalities unique. Every output that expands back to branches records `branches_in_municipality` so the duplication is explicit and reversible.

## 2. Municipal boundary

For rainfall extraction, the municipal polygon is retrieved from the Philippine government GeoRiskPH/ULAP municipal layer:

`https://ulap-nga.georisk.gov.ph/arcgis/rest/services/PSA/Municipal/MapServer/0`

The query filters `psgc_10d` using the supplied 10-digit PSGC. The returned municipality/city name, province, and PSGC are recorded with the output so a wrong geographic feature is detectable. Every returned feature is validated against the workbook's matched name and province (comparison only, ignoring `City of`/`Sto.`/punctuation and known spelling variants such as `Baliuag`/`Baliwag`) before use.

When the exact PSGC returns no feature, the extractor falls back in this order, validating every candidate the same way and logging which fallback supplied the boundary:

1. **District split** — a city-level code (e.g. `1380600000`, City of Manila) may exist only as district-level features (`City of Manila - Binondo`, …); all district features whose name starts with the city name are combined into one boundary.
2. **Legacy PSGC** — Negros Island Region (`18…`) codes may exist in the layer only under the pre-2024 two-digit region prefix (`06…` or `07…` with the same remainder); the legacy feature is used and the legacy code is reported.
3. **Name lookup** — `city_name LIKE` filtered by normalized name and province; ambiguous results abort the run.

MultiPolygon boundaries are supported; every exterior ring participates in the grid-cell overlay and their areas are summed. Note for City of Manila: the GeoRiskPH layer currently carries only 9 of Manila's districts (~29.7 km² of the city's ~42.9 km²), so Manila rows represent only the area available in the boundary source; the recorded `municipality_area_m2` reflects this. **This is a genuine coverage gap: Manila volume figures describe ~69% of the city's true area, and no correction multiplier is invented** — the shortfall is disclosed and visible in the data instead.

Cached boundary lookup artifacts live at `data/cache/boundary-<psgc>.json`, each containing the raw GeoRiskPH GeoJSON plus the fallback source that supplied it — so every boundary in every output is re-checkable against the government layer.

## 3. What CHIRPS actually is — before any math

This matters more than the arithmetic that follows, so it comes first.

CHIRPS (Climate Hazards Group InfraRed Precipitation with Station data) is **not a measurement of rain on the ground**. It is a modelled estimate assembled from three very different ingredients:

1. **Satellite infrared imagery** — geostationary satellites observe cloud-top temperature. Cold cloud tops correlate with deep convective rainfall. This correlation is strong for big thunderstorm systems and poor for warm-rain drizzle, orographic stratus, and shallow monsoon bands.
2. **A climatological pedigree** — the satellite signal is calibrated against long-term reference means (CHPclim), which anchors the *pattern* of rainfall geography (which places are wet) but can flatten local extremes.
3. **Gauge stations, blended in** — actual rain-gauge reports from national meteorological services and global archives are merged where available. In densely gauged places, CHIRPS trends toward gauge reality; in sparsely gauged mountains and islands, the satellite model carries more weight.

For the Philippines specifically: dense coastal/metro stations (Metro Manila, Cebu, Davao) anchor CHIRPS decently; the Cordillera ridges, eastern-coast orographic bands (Bicol, Samar, Aurora), and small islands are predominantly **model territory with weak gauges**. This is exactly where the per-municipality CliMap comparison in §8 shows the largest divergence.

**Resolution**: 0.05° ≈ 5.5 km × 5.4 km per pixel. A CHIRPS pixel value is the estimate for ~30 km² of land — roughly 5,000 hectares, several barangays. It cannot see a thunderstorm that drenched one barangay and skipped the next; it represents the *area-average* over 30 km².

**Product flavours** (v3):
- `rnl` (reanalysis) — the default everywhere in this repo. Daily guesses are produced by distributing the CHIRPS pentad (5-day) totals using ERA5 reanalysis day-shapes. The trade: smooth, consistent, sometimes misses an intense 3-hour episode that never appears in ERA5, but (critically) never invents a deluge out of nothing.
- `sat` — an alternative daily disaggregation using IMERG satellite-only estimates for within-pentad timing. Live-satellite timing, noisier. Not used here; any future use must be recorded explicitly per the data rules.
- **Final vs Prelim** — the Final product has passed the gauge blending and quality pipeline (~6-week lag at publishing); Prelim trails at near-real-time without the station merge. **Only Final is used in this repo.** Prelim values may later change and are not auditable against a stable source.

Every output row carries the exact raster URL of the source file it was computed from, making each figure traceable to a specific public artifact.

## 4. From pixels to a municipality: the overlay math

Each CHIRPS grid-cell polygon touching the municipal boundary is intersected with the municipality polygon. Areas are computed in a Lambert azimuthal equal-area projection centred on the municipality (distortion at municipal scale ≈ negligible). For valid cells only (finite, non-negative rainfall):

```text
weighted_sum_mm_m2              = Σ(pixel_rainfall_mm × municipality_cell_overlap_m2)
area_weighted_rainfall_mm       = weighted_sum_mm_m2 ÷ covered_area_m2
estimated_precipitation_volume_m3 = weighted_sum_mm_m2 ÷ 1,000
```

Why each step:

- **`rainfall_mm` (the first quantity) is the area-weighted average depth** over the municipality. If a municipality spans two pixels — one reporting 20 mm, the other 0 mm — and the municipality is exactly half under each, the output is 10 mm. It is *not* "the rain where the branch building is", it is "the rain you would get if the whole municipality caught its average".
- **`estimated_precipitation_volume_m3`** answers the different question: "how much water fell on the municipality in total?" mm ÷ 1,000 converts a water depth to metres; metres × m² of overlap = m³ of water. Equivalent: `Σ pixel_mm × overlap_m² ÷ 1,000`. No correction for interception, infiltration, runoff, or evaporation is applied — this is the *gross input from the sky*, nothing more.
- Both quantities are computed from the same per-cell weighted sum. They differ only in presentation (depth vs volume). If a row's mm and volume don't satisfy `volume ≈ mm × area × coverage ÷ 1,000` (± rounding), the row is suspect.

Determinism: rasters are decoded as single-band float32; values are never interpolated, smoothed, or infilled. Percent coverage, per-cell contribution strings (`row:col|mm|overlap_m2`, in the daily/monthly canonical files), and the exact source URL are preserved. Any number can be recomputed bit-for-bit from the cell index + the cited raster.

## 5. What the estimate can and cannot be — the honest accuracy statement

This is the section to re-read before acting on any single number.

**It can reasonably be used for:**

- **Seasonal, monthly, and yearly patterns** across many municipalities — "which of our branches sit in wetter municipalities", "how did Q3 rainfall compare to last year", drought or monsoon monitoring at scale. At these scales CHIRPS's documented performance in the Philippines is typically within ±10–25% of gauge-based analyses, and the systematic (bi)direction of the bias is fairly stable over time.
- **Municipality-vs-municipality ranking**, e.g. "which branches sit in the wettest municipalities this month". Relative comparisons are much more trustworthy than absolute values.
- **Anomaly detection**: a month 2–3× the prior years' mean for the same municipality (like Abucay July 2021's 1,236 mm, a real monsoon event, or Quezon City July 2021's ~786 mm from the same system) is a genuine signal even if the *absolute* value is coarse.
- **Long baselines and trend context** — 2018–present is long enough that the gauge-blended Final product tracks the climate.

**It cannot honestly be used for:**

- **Point truth at the branch site.** A branch building experiences its own rainfall. CHIRPS's 30 km² pixel cannot see the shower that missed the site; a branch and its municipality-level value should be expected to differ on any given day, often substantially (daily mm can deviate by factors of 2–3 in either direction at pixel-vs-gauge scale). For site-level truth you need an on-site or very-nearby rain gauge. This remains true even with perfect code — it is the sensor's physics, not a software bug.
- **Legal/financial/compliance determinations** (insurance triggers, force-majeure claims, contractual penalties). A gridded modelled estimate will not survive scrutiny where a calibrated gauge record or an instrumented standard is expected.
- **Exact catchment/runoff accounting.** Volumes here are gross precipitation onto land, not streamflow, not reservoir inflow, not "usable water". Surface response (infiltration, runoff coefficient, evaporation) dominates the transformation from rainfall to usable water and is deliberately *not* modelled here — inventing a runoff coefficient would be fabrication.
- **Sub-daily or intra-day attribution.** The `rnl` daily disaggregation uses ERA5's day-shape; a short intense burst is smeared across the day or hit-and-missed. Use `rnl` daily values as daily totals, not as intra-day reality.
- **Small municipalities in mountainous or coastal gradients.** A 5.5 km pixel blends rain falling on the windward ridge with rain in the leeward valley. Municipalities spanning steep gradients (Cordillera, Sierra Madre foothills, the coastal Zambales corridor) average out real spatial variability. The overlay's *coverage* column tells you when pixels only partially intersect; partial coverage is a flag for caution, not an error per se.

**Concrete known failure modes observed during the build:**

- **Dry-month floors**: Mar–Apr CHIRPS values for Luzon municipalities are frequently near-zero (0.5–2 mm). This is plausible but partly an artefact of IR-only sensitivity in the dry season — shallow drizzle behind monsoon breaks often goes uncounted. Gauge truth might be 5–15 mm. Direction: CHIRPS reads *drier* — for the months where it matters least in practice.
- **Orographic wet-side undersampling**: on east-facing Bicol/Samar/Aurora coasts CHIRPS runs *below* station-informed analyses (our per-municipality CliMap comparison saw Visayas ratios CHIRPS/CliMap up to 1.5+, i.e. CHIRPS substantially lower there sometimes). Orographic rain embedded in warm cloud bands is one of CHIRPS's weakest signatures in the tropics.
- **Tropical cyclones (typhoon passage)**: during a passing typhoon the 0.05° cell-average is a blur of a couple hundred kilometres of heterogeneous rain bands. A municipal value during typhoon days is a coarse regional signal — useful for "was this typhoon heavy here", useless for "how much rain did my site get".
- **Urban heat islands**: not resolved. Rain enhancement/depletion around metro cores is below the sensor's resolution.

**What would make these numbers more trustworthy** (deliberately not done — shortcuts would be fabrication):

- **Calibration against PAGASA rain gauges** per station. The repo already contains PAGASA station parsers (`work/synop-*.html`, `work/compare_science_garden_july_2026.py`) and a four-source comparison for Science Garden Quezon City. A proper bias-correction (per-station CHIRPS/gauge ratio, applied to nearby municipalities) would be the single biggest accuracy upgrade. It has not been done here, and no un-disclaimed calibrated series should be claimed.
- **Higher-resolution inputs** (PAGASA's own 1 km ClimGridPh rasters when they become public as history rather than climatology) would tighten municipal averaging but come with their own document set.

## 6. Composite products: the exact pipeline

### 6.1 Monthly series (2018-01 → 2026-07, `work/chirps-monthly-branch-volume.mjs`)

For long histories, the run uses CHIRPS v3 Final **monthly** rnl composites (`https://data.chc.ucsb.edu/products/CHIRPS/v3.0/monthly/global/tifs/chirps-v3.0.YYYY.MM.tif`, no `monthly` token in the server filename) instead of summing ~3,100 daily rasters: 103 files × ~22 MB instead of ~59 GB.

Equivalence was verified with `work/validate_monthly_vs_daily.mjs`: for July 2026, the monthly composite equals the sum of the 31 Final daily `rnl` files on every sampled land cell and every Apalit intersecting cell (max relative difference 2.9e-7, float32 rounding only). This is the program's guarantee that the monthly source is *numerically identical* to the daily source, not merely "close".

Municipality boundaries and per-cell overlap areas are pre-computed once by `work/build_cell_index.mjs` into `work/branch_cell_index.json` (234 unique municipalities, 3,130 cells), using the same GeoRiskPH resolution and fallback order as §2. Each matched branch row is then expanded per month; branches sharing a municipality carry the same municipality-level value (`branches_in_municipality` records the sharing). Province-only inputs (Abra, Antique) are excluded. Per-cell contributions are not repeated per output row; they live in the cell index keyed by `psgc_10d`.

Output columns record month, branch, PSGC (10-char text), municipality/province/region, product, exact raster URL, grid-cell count, area, coverage, monthly mm, and estimated volume in m³ (`Σ mm × overlap_m² ÷ 1,000`). Volume figures are modelled precipitation volume estimates, same caveats as §5.

### 6.2 Daily series (`work/chirps-daily-branch-volume.mjs`)

The daily companion uses Final daily `rnl` files for per-day volumes. Each 19 MB raster is downloaded, decoded, aggregated for all 234 municipalities via the §6.1 cell index, then **deleted** (peak scratch ~66 MB; the whole 2018–2026 run transferred ~59 GB while holding constant disk). The run is **resumable** through `work/daily/daily_progress.txt` (one date per line).

Canonical output: `work/daily/municipality_daily.csv` (733,356 rows = 234 municipalities × 3,134 days), which is then expanded to per-branch yearly files `outputs/branches_chirps_v3_rnl_daily_YYYY.csv` (1,150,178 rows = 367 branches × 3,134 days). **Branch expansion duplicates the municipality value across branches sharing a PSGC** — e.g. Pasig's three branch rows all carry Pasig's municipality value. Averaging daily values across July days therefore produces a *mean daily mm*, not the monthly total: monthly total = sum of daily values ÷ `branches_in_municipality` when multiple branches share the municipality, or one branch's plain sum when `branches_in_municipality = 1`. The per-cell audit trail lives once in the canonical file/cell index, not per branch row.

Cross-check path: summing the daily canonical file per municipality per month must reproduce the monthly composite's volume (verified during the per-municipality CliMap comparison; worst-case deviation is mm-rounding on near-zero cells, e.g. 0.4 m³ out of 679 million).

## 7. Why municipality-level is the honest resolution (and where barangay/branch-level would lie)

CHIRPS physically represents about 30 km² per pixel. Barangay polygons are typically 0.5–5 km² (metro areas) or 50–500 km² (rural). Subdividing a pixel's value among barangays would either (a) copy the same number into every barangay — a false impression of granularity — or (b) invent spatial gradients the sensor never saw. Interpolating a single pixel (e.g. inverse-distance weighting neighbouring cells) is legitimate as an *interpolation* technique but cannot create information; at 5 km resolution, per-barangay or per-branch precision would be a decoy.

The honest statement is the one this repo makes everywhere: **the estimate exists at municipality level, ~5.5 km grid, and branches inherit it.** If one branch and another sit within the same municipality, they share the value because the source cannot distinguish them; the `branches_in_municipality` column makes that sharing explicit and machine-readable.

## 8. Cross-validation: CHIRPS vs PAGASA CliMap v2.1

As an accuracy sanity check (not a substitute for gauge calibration — see §5), the repo compares CHIRPS 2018-01–2026-07 monthly means against PAGASA's own gridded climatology:

- Product: CliMap v2.1 "historical monthly climatology" — long-term (ClimGridPh reference-period) means per calendar month for 1,647 municipalities (`files/RT_All municipal_monthly climat.csv` at `https://climgridph.pagasa.dost.gov.ph/climapv2/`).
- Joined to the same 234 municipalities by normalized province + municipality, with a bare-name fallback (CliMap lists NCR cities as `City of X`/`X City` under NCR districts), and — because CliMap has **no City of Manila record** (only its districts Binondo/Ermita/Sampaloc/…, some with internal NaN gaps) — the 7 City-of-Manila branches take Ermita's (id 551) full-12-month climatology. This last fallback is visible in the build script (`work/build_baseline.mjs`, the `matchedVia` variable) and in `work/build_cell_index.mjs`; Manila's municipal figure in the comparison is therefore a district-level proxy for the city.
- Headline result over 234 municipalities: annual ratio CHIRPS/CliMap mean **0.99** (national bias practically nil), median 0.96, IQR 0.85–1.09, ~73% of municipalities within ±20%; monthly-shape Pearson correlation mean **0.81**. Divergence: Visayas CHIRPS ≈ −27% (n=15), Mindanao ≈ −17% (n=11), Luzon ±0–6% (n≈208). Worst shape-mismatch municipalities (worst first) are City of Tagum (0.11), Solano (0.41), City of Panabo (0.44), City of General Santos (0.47), City of Tagbilaran (0.49), Baler (0.53) — mostly Davao-region and eastern-coast municipalities where orographic/monsoon timing differences between the two models are strongest.
- Per-municipality table: `work/chirps_climap_per_muni.csv`. National per-month profile (CHIRPS −, wetter): Nov +105%, Feb +38%, Jan +31% vs Mar −66%, Apr −76%, May −37% — a monsoon-onset timing difference more than a volume difference.

Interpretation guardrails for this comparison: both products are gridded models (neither is gauge truth); CliMap is a *climatology* (no year attached), so the comparison validates **means and seasonal shape**, not individual months. Where the two disagree hard (Tagum-type municipalities), the honest statement is "the two public gridded products disagree," not "CHIRPS is right" or "CliMap is right" — resolving that requires gauge data this repo does not yet ingest at scale.

## 9. Data rules and hygiene (reproducing or extending this work)

- **PSGC codes are 10-character text, always.** Never parse them as integers; never drop leading zeros.
- **Every output row carries** the exact CHIRPS product name and source URL, the PSGC, municipality+province names from the boundary source, grid-cell count and per-cell contributions (where applicable), municipality area, coverage, area-weighted mm, and volume in m³ labelled `estimated_precipitation_volume_m3`.
- Volume figures are always labelled as *estimated precipitation volume* (water falling on the mapped area), never "runoff", "water supply", or "gauge".
- Raw rasters and caches (`data/cache/`) are **not** git material; `.gitignore` covers them. The generated daily canonical CSV is retained for the complete project handoff and is tracked through Git LFS because it exceeds GitHub's normal per-file limit. Derived branch CSVs, workbooks, code, and documentation are tracked normally.
- `docs/METHODOLOGY.md` must be updated whenever matching, boundaries, the rainfall product, the area calculation, or the volume formula changes — earlier sections have already been through several product changes and no longer describe stale behaviour by construction.
- Sample validation before shipping a workbook: PSGC 10-char text everywhere; spot-check matched names; no formula errors; preview render. The consistent harness lives in `npm run check` plus the per-artifact validators listed above.
