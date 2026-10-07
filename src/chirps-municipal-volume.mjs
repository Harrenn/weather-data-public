import fs from "node:fs/promises";
import path from "node:path";
import { toPsgc10 } from "./lib/psgc.mjs";
import { requireWorkspacePackage } from "./lib/runtime.mjs";
import { buildGridContext, csvEscape, daysInMonth, extentOf } from "./lib/geometry.mjs";

const sharp = requireWorkspacePackage("sharp");

function readArgs(argv) {
  const args = { product: "rnl" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Usage: --psgc <10-digit> --year <yyyy> --month <1-12> --output <csv> [--product rnl|sat]");
    args[key.slice(2)] = value;
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
const psgc = toPsgc10(args.psgc);
const year = Number(args.year);
const month = Number(args.month);
if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Year and month must be valid integers.");
if (!["rnl", "sat"].includes(args.product)) throw new Error("Product must be rnl or sat.");
if (!args.output) throw new Error("Missing --output.");

const boundaryUrl = new URL("https://ulap-nga.georisk.gov.ph/arcgis/rest/services/PSA/Municipal/MapServer/0/query");
boundaryUrl.searchParams.set("where", `psgc_10d='${psgc}'`);
boundaryUrl.searchParams.set("outFields", "*");
boundaryUrl.searchParams.set("returnGeometry", "true");
boundaryUrl.searchParams.set("f", "geojson");
const boundaryResponse = await fetch(boundaryUrl);
if (!boundaryResponse.ok) throw new Error(`Boundary request failed: ${boundaryResponse.status} ${boundaryResponse.statusText}`);
const boundaryCollection = await boundaryResponse.json();
if (boundaryCollection.features?.length !== 1) throw new Error(`Expected one municipal boundary for PSGC ${psgc}, received ${boundaryCollection.features?.length ?? 0}.`);
const feature = boundaryCollection.features[0];
if (feature.properties.psgc_10d !== psgc) throw new Error("Boundary service returned a different PSGC than requested.");
if (!["Polygon", "MultiPolygon"].includes(feature.geometry.type)) throw new Error(`Unsupported boundary geometry: ${feature.geometry.type}`);
const exteriorRings = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates[0]] : feature.geometry.coordinates.map((polygon) => polygon[0]);

const ring = exteriorRings[0];
const grid = buildGridContext(exteriorRings);
const municipalityAreaM2 = grid.municipalityAreaM2;
const cells = grid.cells;

const extent = extentOf(exteriorRings.flat());
const minCol = Math.floor((extent.minLon + 180) / 0.05);
const minRow = Math.floor((60 - extent.maxLat) / 0.05);
const maxCol = Math.floor((extent.maxLon + 180) / 0.05);
const maxRow = Math.floor((60 - extent.minLat) / 0.05);
const width = maxCol - minCol + 1;
const height = maxRow - minRow + 1;

const headers = [
  "date", "municipality_city", "province", "region", "psgc_10d", "chirps_product", "chirps_source_url",
  "grid_cells_intersected", "valid_grid_cells", "municipality_area_m2", "covered_area_m2", "coverage_pct",
  "weighted_sum_mm_m2", "area_weighted_precipitation_mm", "estimated_precipitation_volume_m3_excel_formula",
  "calculated_volume_m3_static", "formula_vs_static_difference_m3", "cell_contributions_row_col_mm_area_m2", "area_method",
];
const lines = [headers.map(csvEscape).join(",")];
const totalDays = daysInMonth(year, month);
const firstDay = args.day ? Number(args.day) : 1;
const lastDay = args.day ? Number(args.day) : totalDays;
if (!Number.isInteger(firstDay) || firstDay < 1 || firstDay > totalDays) throw new Error("--day must be a valid day in the requested month.");
for (let day = firstDay; day <= lastDay; day += 1) {
  const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const sourceDate = date.replaceAll("-", ".");
  const fileName = `chirps-v3.0.${args.product}.${sourceDate}.tif`;
  const sourceUrl = `https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/${args.product}/${year}/${fileName}`;
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": "philippines-municipal-rainfall/0.1" },
  });
  if (!response.ok) throw new Error(`CHIRPS download failed for ${date}: ${response.status} ${response.statusText}`);
  const raster = sharp(Buffer.from(await response.arrayBuffer()));
  const metadata = await raster.metadata();
  if (metadata.width !== 7200 || metadata.height !== 2400 || metadata.depth !== "float") throw new Error(`Unexpected CHIRPS raster metadata for ${date}.`);
  const { data, info } = await raster.extract({ left: minCol, top: minRow, width, height }).toColourspace("b-w").raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || info.depth !== "float") throw new Error(`Unexpected raster layout for ${date}.`);
  const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const valid = cells.map((cell) => ({ ...cell, precipitationMm: values[(cell.row - minRow) * width + (cell.col - minCol)] })).filter((cell) => Number.isFinite(cell.precipitationMm) && cell.precipitationMm >= 0);
  const coveredAreaM2 = valid.reduce((sum, cell) => sum + cell.overlapAreaM2, 0);
  const weightedSumMmM2 = valid.reduce((sum, cell) => sum + cell.precipitationMm * cell.overlapAreaM2, 0);
  if (!(coveredAreaM2 > 0)) {
    throw new Error(`${date}: the municipality did not overlap a usable CHIRPS cell.`);
  }
  const areaWeightedMm = weightedSumMmM2 / coveredAreaM2;
  const staticVolumeM3 = weightedSumMmM2 / 1000;
  // `lines` already contains the header; this also stays correct for --day smoke tests.
  const csvRowNumber = lines.length + 1;
  const contributions = valid.map((cell) => `${cell.row}:${cell.col}|${cell.precipitationMm.toFixed(6)}mm|${cell.overlapAreaM2.toFixed(3)}m2`).join("; ");
  lines.push([
    date, feature.properties.city_name, feature.properties.prov_name, feature.properties.reg_name, psgc,
    `CHIRPS v3 Final ${args.product}`, sourceUrl, cells.length, valid.length, municipalityAreaM2.toFixed(3),
    coveredAreaM2.toFixed(3), (coveredAreaM2 / municipalityAreaM2).toFixed(10), weightedSumMmM2.toFixed(3),
    areaWeightedMm.toFixed(6), `=ROUND(M${csvRowNumber}/1000,3)`, staticVolumeM3.toFixed(3),
    `=O${csvRowNumber}-P${csvRowNumber}`, contributions,
    "Lambert azimuthal equal-area polygon-to-cell intersections; mm·m² ÷ 1000 = m³",
  ].map(csvEscape).join(","));
}
await fs.mkdir(path.dirname(args.output), { recursive: true });
await fs.writeFile(args.output, `${lines.join("\r\n")}\r\n`, "utf8");
console.log(JSON.stringify({ output: args.output, psgc, municipality: feature.properties.city_name, days: lastDay - firstDay + 1, cells: cells.length }, null, 2));
