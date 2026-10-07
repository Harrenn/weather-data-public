import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { normalizeLocation, toPsgc10 } from "./lib/psgc.mjs";
import { buildGridContext, csvEscape, daysInMonth } from "./lib/geometry.mjs";

const RASTER_WIDTH = 7200;

function readArgs(argv) {
  const args = { product: "rnl", cacheDir: "data/cache" };
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error("Usage: --locations <xlsx> --year <yyyy> --month <1-12> --output <csv|xlsx> [--month-end <1-12>] [--psgc <code,code,...>] [--day <d>] [--product rnl|sat] [--limit <n>] [--cache-dir <dir>] [--refresh-boundaries]");
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key.slice(2)] = next;
      index += 2;
    } else {
      args[key.slice(2)] = true;
      index += 1;
    }
  }
  return args;
}

async function readTargets(locationsPath, limit, psgcFilter) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(locationsPath);
  const sheet = workbook.getWorksheet("Sheet1");
  if (!sheet) throw new Error("Locations workbook must contain a worksheet named Sheet1.");
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? ""));
  const index = Object.fromEntries(headers.map((name, position) => [name, position]));
  for (const field of ["Municipality/City PSGC 10d", "PSGC Matched Municipality/City", "PSGC Matched Province"]) {
    if (!(field in index)) throw new Error(`Locations workbook is missing required column: ${field}`);
  }
  const byPsgc = new Map();
  for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber).values.slice(1);
    const codeCell = row[index["Municipality/City PSGC 10d"]];
    if (codeCell === null || codeCell === undefined || codeCell === "") continue;
    let psgc;
    try {
      psgc = toPsgc10(codeCell);
    } catch {
      throw new Error(`Row ${rowNumber}: expected a 10-digit PSGC, received ${JSON.stringify(codeCell)}. Re-run the PSGC matching stage first.`);
    }
    if (byPsgc.has(psgc)) {
      byPsgc.get(psgc).branchCount += 1;
      continue;
    }
    byPsgc.set(psgc, {
      psgc,
      municipality: String(row[index["PSGC Matched Municipality/City"]] ?? "").trim(),
      province: String(row[index["PSGC Matched Province"]] ?? "").trim(),
      branchCount: 1,
    });
  }
  let targets = [...byPsgc.values()];
  if (psgcFilter) {
    const wanted = new Set(String(psgcFilter).split(",").map((code) => toPsgc10(code.trim())));
    targets = targets.filter((target) => wanted.has(target.psgc));
    if (targets.length === 0) {
      throw new Error(`None of the requested PSGC codes (${[...wanted].join(", ")}) are present as matched rows in the locations workbook.`);
    }
  }
  return limit ? targets.slice(0, Number(limit)) : targets;
}

const MUNICIPAL_LAYER = "https://ulap-nga.georisk.gov.ph/arcgis/rest/services/PSA/Municipal/MapServer/0/query";

async function queryBoundaryWhere(where, resultRecordCount = 100) {
  const url = new URL(MUNICIPAL_LAYER);
  url.searchParams.set("where", where);
  url.searchParams.set("outFields", "*");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("resultRecordCount", String(resultRecordCount));
  url.searchParams.set("f", "geojson");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Boundary request failed (${where}): ${response.status} ${response.statusText}`);
  const collection = await response.json();
  return collection.features ?? [];
}

function expectPolygonFeatures(features, requestedPsgc) {
  for (const feature of features) {
    if (!["Polygon", "MultiPolygon"].includes(feature.geometry.type)) {
      throw new Error(`Unsupported boundary geometry for ${requestedPsgc}: ${feature.geometry.type}`);
    }
  }
  return features;
}

function boundaryNameMatches(cityName, target) {
  const candidate = normalizeLocation(cityName);
  const expected = normalizeLocation(target.municipality);
  return candidate === expected || (expected && candidate.startsWith(`${expected} `));
}

function validateFeatureAgainstTarget(feature, target) {
  if (!boundaryNameMatches(feature.properties.city_name, target)) {
    throw new Error(`Boundary name mismatch for ${target.psgc}: GeoRiskPH returned "${feature.properties.city_name}", workbook expects "${target.municipality}".`);
  }
  if (target.province && normalizeLocation(feature.properties.prov_name) !== normalizeLocation(target.province)) {
    throw new Error(`Boundary province mismatch for ${target.psgc}: GeoRiskPH returned "${feature.properties.prov_name}", workbook expects "${target.province}".`);
  }
}

async function loadBoundary(target, cacheDir, refresh) {
  const cachePath = path.join(cacheDir, `boundary-${target.psgc}.json`);
  if (!refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
      const features = cached.type === "Feature" ? [cached] : cached.features;
      for (const feature of features) validateFeatureAgainstTarget(feature, target);
      return { features, source: cached.source ?? "cache" };
    } catch (error) {
      if (!(error instanceof SyntaxError) && error.code !== "ENOENT") throw error;
    }
  }

  const find = async (where) => await queryBoundaryWhere(where).then((features) => expectPolygonFeatures(features, target.psgc));

  let features = await find(`psgc_10d='${target.psgc}'`);
  let source = "exact";
  if (features.length > 1) throw new Error(`Expected one municipal boundary for PSGC ${target.psgc}, received ${features.length}.`);
  if (features.length === 0) {
    const prefix = target.psgc.slice(0, 6);
    const split = (await find(`psgc_10d LIKE '${prefix}%'`)).filter((feature) => boundaryNameMatches(feature.properties.city_name, target));
    if (split.length > 0) {
      features = split;
      source = "district-split";
    }
  }
  if (features.length === 0 && target.psgc.startsWith("18")) {
    for (const legacyPrefix of ["06", "07"]) {
      const legacy = await find(`psgc_10d='${legacyPrefix}${target.psgc.slice(2)}'`);
      if (legacy.length === 1) {
        features = legacy;
        source = `legacy-psgc (${features[0].properties.psgc_10d})`;
        break;
      }
    }
  }
  if (features.length === 0) {
    const core = target.municipality.replace(/^city of /i, "").replace(/ city$/i, "").trim();
    if (core) {
      const byName = (await find(`city_name LIKE '%${core.replaceAll("'", "''")}%'`))
        .filter((feature) => normalizeLocation(feature.properties.city_name) === normalizeLocation(target.municipality))
        .filter((feature) => !target.province || normalizeLocation(feature.properties.prov_name) === normalizeLocation(target.province));
      if (byName.length === 1) {
        features = byName;
        source = `name-lookup (${features[0].properties.psgc_10d})`;
      } else if (byName.length > 1) {
        throw new Error(`Ambiguous boundary name lookup for ${target.psgc} ("${target.municipality}"): ${byName.map((feature) => `${feature.properties.psgc_10d} ${feature.properties.city_name}`).join(", ")}.`);
      }
    }
  }
  if (features.length === 0) throw new Error(`No municipal boundary found for PSGC ${target.psgc} ("${target.municipality}") in the GeoRiskPH layer.`);
  for (const feature of features) validateFeatureAgainstTarget(feature, target);

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify({ features, source }));
  return { features, source };
}

async function downloadRaster(sourceUrl, cachePath) {
  try {
    return await fs.readFile(cachePath);
  } catch {}
  console.error(`Downloading ${path.basename(cachePath)} ...`);
  const response = await fetch(sourceUrl, { headers: { "User-Agent": "philippines-municipal-rainfall/0.1" } });
  if (!response.ok) throw new Error(`CHIRPS download failed for ${path.basename(cachePath)}: ${response.status} ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, buffer);
  return buffer;
}

async function decodeRaster(buffer, date) {
  const raster = sharp(buffer);
  const metadata = await raster.metadata();
  if (metadata.width !== RASTER_WIDTH || metadata.height !== 2400 || metadata.depth !== "float") {
    throw new Error(`Unexpected CHIRPS raster metadata for ${date}.`);
  }
  const { data, info } = await raster.toColourspace("b-w").raw({ depth: "float" }).toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || info.depth !== "float") throw new Error(`Unexpected raster layout for ${date}.`);
  return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
}

const args = readArgs(process.argv.slice(2));
for (const field of ["locations", "year", "month", "output"]) {
  if (!args[field]) throw new Error(`Missing --${field}`);
}
const year = Number(args.year);
const month = Number(args.month);
const monthEnd = args["month-end"] ? Number(args["month-end"]) : month;
if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) throw new Error("Year and month must be valid integers.");
if (!Number.isInteger(monthEnd) || monthEnd < month || monthEnd > 12) throw new Error("--month-end must be an integer between --month and 12.");
if (!["rnl", "sat"].includes(args.product)) throw new Error("Product must be rnl or sat.");

const targets = await readTargets(args.locations, args.limit, args.psgc);
if (targets.length === 0) throw new Error("No rows with a matched Municipality/City PSGC 10d were found in the locations workbook.");

console.error(`Preparing ${targets.length} municipal boundaries...`);
const contexts = new Map();
const boundaryFallbacks = [];
for (const target of targets) {
  const { features, source } = await loadBoundary(target, args.cacheDir, Boolean(args["refresh-boundaries"]));
  const exteriorRings = features.flatMap((feature) => {
    const geometry = feature.geometry;
    return geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]);
  });
  const grid = buildGridContext(exteriorRings);
  contexts.set(target.psgc, { target, features, grid });
  if (source !== "exact") {
    boundaryFallbacks.push({ psgc: target.psgc, municipality: target.municipality, source, features: features.length });
    console.error(`  ${target.psgc} ${target.municipality}: boundary via ${source} (${features.length} feature${features.length === 1 ? "" : "s"})`);
  }
}

const headers = [
  "date", "municipality_city", "province", "region", "psgc_10d", "chirps_product", "chirps_source_url",
  "grid_cells_intersected", "valid_grid_cells", "municipality_area_m2", "covered_area_m2", "coverage_pct",
  "weighted_sum_mm_m2", "area_weighted_precipitation_mm", "estimated_precipitation_volume_m3_excel_formula",
  "calculated_volume_m3_static", "formula_vs_static_difference_m3", "cell_contributions_row_col_mm_area_m2", "area_method",
];
const records = [];
const firstDay = args.day ? Number(args.day) : 1;
if (!Number.isInteger(firstDay) || firstDay < 1 || firstDay > daysInMonth(year, month)) throw new Error("--day must be a valid day in the requested month.");
let days = 0;

for (let currentMonth = month; currentMonth <= monthEnd; currentMonth += 1) {
  const monthLastDay = args.day ? Number(args.day) : daysInMonth(year, currentMonth);
  for (let day = firstDay; day <= monthLastDay; day += 1) {
    const date = `${year}-${String(currentMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const sourceDate = date.replaceAll("-", ".");
    const fileName = `chirps-v3.0.${args.product}.${sourceDate}.tif`;
    const sourceUrl = `https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/${args.product}/${year}/${fileName}`;
    const cachePath = path.join(args.cacheDir, fileName);
    const values = await decodeRaster(await downloadRaster(sourceUrl, cachePath), date);
    for (const { target, features, grid } of contexts.values()) {
      const primary = features[0].properties;
      const municipalityCity = features.length === 1 ? primary.city_name : target.municipality;
      const province = features.length === 1 ? primary.prov_name : (target.province || primary.prov_name);
      const valid = grid.cells
        .map((cell) => ({ ...cell, precipitationMm: values[cell.row * RASTER_WIDTH + cell.col] }))
        .filter((cell) => Number.isFinite(cell.precipitationMm) && cell.precipitationMm >= 0);
      const coveredAreaM2 = valid.reduce((sum, cell) => sum + cell.overlapAreaM2, 0);
      const weightedSumMmM2 = valid.reduce((sum, cell) => sum + cell.precipitationMm * cell.overlapAreaM2, 0);
      if (!(coveredAreaM2 > 0)) {
        throw new Error(`${date}: ${target.municipality} (${target.psgc}) did not overlap a usable CHIRPS cell.`);
      }
      const areaWeightedMm = weightedSumMmM2 / coveredAreaM2;
      const staticVolumeM3 = weightedSumMmM2 / 1000;
      const sheetRowNumber = records.length + 2;
      const contributions = valid.map((cell) => `${cell.row}:${cell.col}|${cell.precipitationMm.toFixed(6)}mm|${cell.overlapAreaM2.toFixed(3)}m2`).join("; ");
      records.push([
        date, municipalityCity, province, primary.reg_name, target.psgc,
        `CHIRPS v3 Final ${args.product}`, sourceUrl, grid.cells.length, valid.length, grid.municipalityAreaM2.toFixed(3),
        coveredAreaM2.toFixed(3), (coveredAreaM2 / grid.municipalityAreaM2).toFixed(10), weightedSumMmM2.toFixed(3),
        areaWeightedMm.toFixed(6), `=ROUND(M${sheetRowNumber}/1000,3)`, staticVolumeM3.toFixed(3),
        `=O${sheetRowNumber}-P${sheetRowNumber}`, contributions,
        "Lambert azimuthal equal-area polygon-to-cell intersections; mm·m² ÷ 1000 = m³",
      ]);
    }
    console.error(`${date}: ${targets.length} municipalities done.`);
    days += 1;
  }
}

await fs.mkdir(path.dirname(args.output), { recursive: true });
if (/\.xlsx$/i.test(args.output)) {
  const numericIndexes = new Set([7, 8, 9, 10, 11, 12, 13, 15]);
  const cellValue = (value, index) => {
    if (typeof value === "string" && value.startsWith("=")) return { formula: value.slice(1) };
    if (numericIndexes.has(index)) return Number(value);
    return value;
  };
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addTable({
    name: "ChirpsVolumeTable",
    ref: "A1",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headers.map((name) => ({ name, filterButton: true })),
    rows: records.map((record) => record.map(cellValue)),
  });
  for (let rowNumber = 2; rowNumber <= records.length + 1; rowNumber += 1) {
    sheet.getCell(`E${rowNumber}`).numFmt = "@";
    sheet.getCell(`L${rowNumber}`).numFmt = "0.0000000000";
    sheet.getCell(`M${rowNumber}`).numFmt = "0.000";
    sheet.getCell(`N${rowNumber}`).numFmt = "0.000000";
    sheet.getCell(`P${rowNumber}`).numFmt = "0.000";
  }
  for (const [index, width] of [[1, 11], [2, 24], [3, 14], [4, 24], [5, 14], [6, 20], [7, 60], [10, 20], [11, 20], [13, 18], [14, 16], [15, 20], [16, 18], [18, 60], [19, 40]]) {
    sheet.getColumn(index).width = width;
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  await workbook.xlsx.writeFile(args.output);
} else {
  const lines = [headers.map(csvEscape).join(","), ...records.map((record) => record.map(csvEscape).join(","))];
  await fs.writeFile(args.output, `${lines.join("\r\n")}\r\n`, "utf8");
}
console.log(JSON.stringify({
  output: args.output,
  product: args.product,
  year,
  months: `${month}${monthEnd !== month ? `-${monthEnd}` : ""}`,
  municipalities: targets.length,
  days,
  rows: records.length,
  boundaryFallbacks,
}, null, 2));
