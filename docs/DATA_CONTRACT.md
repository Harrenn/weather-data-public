# Data contract

## Location workbook

Required column:

| Column | Rule |
|---|---|
| `Matched PSGC Location` | Municipality/city and province where possible, such as `Apalit, Pampanga` or `City of Bacoor, Cavite`. |

The matcher preserves existing columns and appends a municipal/city PSGC code plus match audit columns.

## PSGC reference CSV

Required fields from the PSA masterlist:

- `city_municipality_code`
- `city_municipality_name`
- `city_municipality_type`
- `province_name`
- `region_name`

`city_municipality_code` must be represented as exactly 10 text characters. The matcher protects against an accidental nine-digit cleaned value by left-padding it once; values of any other length are rejected.

## Rainfall output

One row represents one calendar day and one municipality/city. Required audit fields include the PSGC, CHIRPS product, raster URL, number of intersected/valid cells, municipal and covered area, weighted rainfall, raw weighted sum, estimated volume, and grid-cell contribution details.

