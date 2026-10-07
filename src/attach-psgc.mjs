import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { matchLocation, readMunicipalities } from "./lib/psgc.mjs";

function readArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Usage: --locations <xlsx> --psgc-reference <csv> --output <xlsx>");
    args[key.slice(2)] = value;
  }
  return args;
}

const args = readArgs(process.argv.slice(2));
for (const field of ["locations", "psgc-reference", "output"]) {
  if (!args[field]) throw new Error(`Missing --${field}`);
}

const places = readMunicipalities(await fs.readFile(args["psgc-reference"], "utf8"));
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(args.locations);
const sheet = workbook.getWorksheet("Sheet1");
if (!sheet) throw new Error("Workbook must contain a worksheet named Sheet1.");

const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? ""));
const branchIndex = headers.indexOf("Branch Name");
const locationIndex = headers.indexOf("Matched PSGC Location");
if (branchIndex < 0 || locationIndex < 0) throw new Error("Location workbook must contain Branch Name and Matched PSGC Location columns.");

const existingTable = Object.values(sheet.tables ?? {})[0];
const existingStyle = existingTable?.style?.theme ?? "TableStyleMedium2";
if (existingTable) sheet.removeTable(existingTable.name);

const rowCount = sheet.actualRowCount;
const rows = [];
for (let rowNumber = 2; rowNumber <= rowCount; rowNumber += 1) {
  const values = sheet.getRow(rowNumber).values.slice(1);
  if (values.every((value) => value === null || value === undefined || value === "")) continue;
  rows.push(values);
}

const matchRows = rows.map((row) => matchLocation({
  branchName: row[branchIndex],
  matchedLocation: row[locationIndex],
  places,
}));

sheet.getCell("D1").value = "Municipality/City PSGC 10d";
sheet.getCell("E1").value = "PSGC Matched Municipality/City";
sheet.getCell("F1").value = "PSGC Matched Province";
sheet.getCell("G1").value = "PSGC Match Status";

matchRows.forEach((result, index) => {
  const rowNumber = index + 2;
  const codeCell = sheet.getCell(`D${rowNumber}`);
  codeCell.value = result.place?.code ?? "";
  codeCell.numFmt = "@";
  sheet.getCell(`E${rowNumber}`).value = result.place?.name ?? "";
  sheet.getCell(`F${rowNumber}`).value = result.place?.province ?? result.target.locality;
  sheet.getCell(`G${rowNumber}`).value = result.place
    ? "Matched"
    : result.status === "Province-only input"
      ? "Province-only input — no municipality/city PSGC"
      : result.status;
});

const widths = [26, 11, 40, 24, 28, 24, 38];
widths.forEach((width, index) => {
  sheet.getColumn(index + 1).width = width;
});
sheet.views = [{ state: "frozen", ySplit: 1, showGridLines: false }];

sheet.addTable({
  name: "LocationsWithPsgcTable",
  ref: "A1",
  headerRow: true,
  style: { theme: existingStyle, showRowStripes: true },
  columns: headers.concat(["Municipality/City PSGC 10d", "PSGC Matched Municipality/City", "PSGC Matched Province", "PSGC Match Status"]).slice(0, 7).map((name) => ({ name, filterButton: true })),
  rows: matchRows.map((result, index) => {
    const row = rows[index];
    return [
      row[0] ?? "", row[1] ?? "", row[2] ?? "",
      result.place?.code ?? "",
      result.place?.name ?? "",
      result.place?.province ?? result.target.locality,
      result.place ? "Matched" : result.status === "Province-only input" ? "Province-only input — no municipality/city PSGC" : result.status,
    ];
  }),
});

await fs.mkdir(path.dirname(args.output), { recursive: true });
await workbook.xlsx.writeFile(args.output);
const summary = matchRows.reduce((counts, result) => {
  const key = result.place ? "matched" : result.status.toLowerCase().replaceAll(" ", "_");
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
console.log(JSON.stringify({ output: args.output, rows: rows.length, ...summary }, null, 2));
