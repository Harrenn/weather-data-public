export function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

export function normalizeLocation(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\b(city|municipality|of)\b/g, " ")
    .replace(/\bsto\.?\b/g, "santo")
    .replace(/\bbaliuag\b/g, "baliwag")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseMatchedLocation(value) {
  const raw = String(value ?? "").trim();
  const parenthetical = raw.match(/\(([^)]+)\)/);
  const core = parenthetical ? parenthetical[1].trim() : raw;
  const parts = core.split(",").map((part) => part.trim()).filter(Boolean);
  return {
    raw,
    locality: parts[0] ?? core,
    province: parts.length > 1 ? parts.at(-1) : "",
    expectsCity: /\bcity\b/i.test(core),
  };
}

export function toPsgc10(code) {
  const text = String(code ?? "").trim();
  if (/^\d{10}$/.test(text)) return text;
  if (/^\d{9}$/.test(text)) return `0${text}`;
  throw new Error(`Expected a 9- or 10-digit municipal/city PSGC code, received: ${JSON.stringify(code)}`);
}

export function readMunicipalities(psgcCsvText) {
  const [headerLine, ...lines] = psgcCsvText.trimEnd().split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  const index = Object.fromEntries(headers.map((name, position) => [name, position]));
  const required = ["city_municipality_code", "city_municipality_name", "city_municipality_type", "province_name", "region_name"];
  for (const field of required) {
    if (!(field in index)) throw new Error(`PSGC reference is missing required field: ${field}`);
  }
  const byCode = new Map();
  for (const line of lines) {
    const fields = parseCsvLine(line);
    const code = fields[index.city_municipality_code];
    if (!code || byCode.has(code)) continue;
    byCode.set(code, {
      code: toPsgc10(code),
      name: fields[index.city_municipality_name],
      type: fields[index.city_municipality_type],
      province: fields[index.province_name],
      region: fields[index.region_name],
    });
  }
  return [...byCode.values()];
}

export function matchLocation({ branchName, matchedLocation, places }) {
  const target = parseMatchedLocation(matchedLocation);
  const provinceNames = new Set(places.map((place) => normalizeLocation(place.province)));
  let candidates = places.filter((place) => normalizeLocation(place.name) === normalizeLocation(target.locality));
  if (target.province) {
    candidates = candidates.filter((place) => normalizeLocation(place.province) === normalizeLocation(target.province));
  }
  if (target.expectsCity && candidates.some((place) => place.type === "city")) {
    candidates = candidates.filter((place) => place.type === "city");
  }
  if (candidates.length > 1) {
    const normalizedBranch = normalizeLocation(branchName);
    const branchProvinceMatches = candidates.filter((place) => normalizedBranch.includes(normalizeLocation(place.province)));
    if (branchProvinceMatches.length === 1) candidates = branchProvinceMatches;
  }
  if (candidates.length === 1) return { status: "Matched", place: candidates[0], target };
  if (candidates.length === 0 && !target.province && provinceNames.has(normalizeLocation(target.locality))) {
    return { status: "Province-only input", place: null, target };
  }
  return { status: candidates.length === 0 ? "Unmatched" : "Ambiguous", place: null, target, candidates };
}

