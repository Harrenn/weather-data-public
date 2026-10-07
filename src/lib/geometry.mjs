export const EARTH_RADIUS_M = 6371007.181;
export const DEG_TO_RAD = Math.PI / 180;

export function extentOf(points) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

export function projectFactory(ring) {
  const { minLon, maxLon, minLat, maxLat } = extentOf(ring);
  const lon0 = ((minLon + maxLon) / 2) * DEG_TO_RAD;
  const lat0 = ((minLat + maxLat) / 2) * DEG_TO_RAD;
  return ([lon, lat]) => {
    const lambda = lon * DEG_TO_RAD;
    const phi = lat * DEG_TO_RAD;
    const delta = lambda - lon0;
    const denominator = 1 + Math.sin(lat0) * Math.sin(phi) + Math.cos(lat0) * Math.cos(phi) * Math.cos(delta);
    const scale = Math.sqrt(2 / denominator);
    return [
      EARTH_RADIUS_M * scale * Math.cos(phi) * Math.sin(delta),
      EARTH_RADIUS_M * scale * (Math.cos(lat0) * Math.sin(phi) - Math.sin(lat0) * Math.cos(phi) * Math.cos(delta)),
    ];
  };
}

export function signedArea(points) {
  return points.reduce((sum, [x1, y1], index) => {
    const [x2, y2] = points[(index + 1) % points.length];
    return sum + x1 * y2 - x2 * y1;
  }, 0) / 2;
}

export function cross([ax, ay], [bx, by], [px, py]) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

export function clipPolygon(subject, clipper) {
  let output = subject;
  for (let edge = 0; edge < clipper.length; edge += 1) {
    const a = clipper[edge];
    const b = clipper[(edge + 1) % clipper.length];
    const input = output;
    output = [];
    for (let index = 0; index < input.length; index += 1) {
      const start = input[index];
      const end = input[(index + 1) % input.length];
      const startCross = cross(a, b, start);
      const endCross = cross(a, b, end);
      const startInside = startCross >= -1e-7;
      const endInside = endCross >= -1e-7;
      if (startInside !== endInside) {
        const t = startCross / (startCross - endCross);
        output.push([start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])]);
      }
      if (endInside) output.push(end);
    }
  }
  return output;
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Identifies the CHIRPS 0.05-degree grid cells intersecting one or more municipal
 * exterior rings (a MultiPolygon boundary passes every exterior ring) and computes
 * their overlap areas in a Lambert azimuthal equal-area projection. Equal-area is
 * centring-independent, so each ring may use its own projection centre.
 */
export function buildGridContext(rings) {
  let municipalityAreaM2 = 0;
  const cellMap = new Map();
  for (const ring of rings) {
    const project = projectFactory(ring);
    const municipalityPolygon = ring.slice(0, -1).map(project);
    municipalityAreaM2 += Math.abs(signedArea(municipalityPolygon));
    const { minLon, maxLon, minLat, maxLat } = extentOf(ring);
    const minCol = Math.floor((minLon + 180) / 0.05);
    const maxCol = Math.floor((maxLon + 180) / 0.05);
    const minRow = Math.floor((60 - maxLat) / 0.05);
    const maxRow = Math.floor((60 - minLat) / 0.05);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const left = -180 + col * 0.05;
        const right = left + 0.05;
        const top = 60 - row * 0.05;
        const bottom = top - 0.05;
        const clipper = [[left, bottom], [right, bottom], [right, top], [left, top]].map(project);
        const overlap = clipPolygon(municipalityPolygon, clipper);
        const overlapAreaM2 = overlap.length >= 3 ? Math.abs(signedArea(overlap)) : 0;
        if (overlapAreaM2 > 0.01) {
          const key = `${row}:${col}`;
          const existing = cellMap.get(key);
          cellMap.set(key, { row, col, overlapAreaM2: (existing?.overlapAreaM2 ?? 0) + overlapAreaM2 });
        }
      }
    }
  }
  return { municipalityAreaM2, cells: [...cellMap.values()] };
}
