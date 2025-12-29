import { contours as d3Contours } from "d3-contour";
import { geoIdentity, geoPath } from "d3-geo";
import JSZip from "jszip";
import { PNG } from "pngjs";

/* ===================== TYPES ===================== */

type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

/* ===================== HELPERS ===================== */

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y =
    ((1 -
      Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
      2) *
    n;
  return { x, y };
}

// Terrarium encoding
function decodeTerrarium(r: number, g: number, b: number) {
  return r * 256 + g + b / 256 - 32768;
}

async function fetchPng(url: string): Promise<PNG> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Tile fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return PNG.sync.read(buf);
}

function nearestSample(src: Float32Array, w: number, h: number, x: number, y: number) {
  const ix = clamp(Math.round(x), 0, w - 1);
  const iy = clamp(Math.round(y), 0, h - 1);
  return src[iy * w + ix];
}

function svgHeader(w: number, h: number) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
  width="${w}in" height="${h}in"
  viewBox="0 0 ${w} ${h}">
`;
}

function svgFooter() {
  return `</svg>\n`;
}

function alignmentHoles(w: number, h: number, d: number, inset: number) {
  const r = d / 2;
  const pts = [
    [inset, inset],
    [w - inset, inset],
    [inset, h - inset],
    [w - inset, h - inset],
  ];
  return pts
    .map(
      ([x, y]) =>
        `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="black" stroke-width="0.001"/>`
    )
    .join("\n");
}

/* ===================== ROUTE ===================== */

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const bounds: Bounds = body.bounds;
    const widthIn = Number(body.widthIn ?? 20);
    const heightIn = Number(body.heightIn ?? 12);
    const intervalM = Number(body.intervalM ?? 30);
    const grid = Number(body.grid ?? 256);

    const addHoles = Boolean(body.addAlignmentHoles ?? true);
    const holeDiameterIn = Number(body.holeDiameterIn ?? 0.125);
    const holeInsetIn = Number(body.holeInsetIn ?? 0.35);

    if (!bounds || widthIn <= 0 || heightIn <= 0 || intervalM <= 0 || grid < 64) {
      return new Response("Bad request", { status: 400 });
    }

    /* ===================== TILE SETUP ===================== */

    const z = 12; // fixed MVP zoom
    const tl = lonLatToTile(bounds.west, bounds.north, z);
    const br = lonLatToTile(bounds.east, bounds.south, z);

    const xMin = Math.floor(Math.min(tl.x, br.x));
    const xMax = Math.floor(Math.max(tl.x, br.x));
    const yMin = Math.floor(Math.min(tl.y, br.y));
    const yMax = Math.floor(Math.max(tl.y, br.y));

    const tileCount = (xMax - xMin + 1) * (yMax - yMin + 1);
    if (tileCount > 64) {
      return new Response("Area too large — zoom in before exporting.", { status: 413 });
    }

    /* ===================== STITCH ELEVATION ===================== */

    const tileSize = 256;
    const stitchedW = (xMax - xMin + 1) * tileSize;
    const stitchedH = (yMax - yMin + 1) * tileSize;
    const stitched = new Float32Array(stitchedW * stitchedH);

    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
        const png = await fetchPng(url);

        for (let py = 0; py < tileSize; py++) {
          for (let px = 0; px < tileSize; px++) {
            const i = (py * tileSize + px) * 4;
            const elev = decodeTerrarium(png.data[i], png.data[i + 1], png.data[i + 2]);

            const gx = (tx - xMin) * tileSize + px;
            const gy = (ty - yMin) * tileSize + py;
            stitched[gy * stitchedW + gx] = elev;
          }
        }
      }
    }

    /* ===================== SAMPLE GRID ===================== */

    const pxWest = (Math.min(tl.x, br.x) - xMin) * tileSize;
    const pxEast = (Math.max(tl.x, br.x) - xMin) * tileSize;
    const pxNorth = (Math.min(tl.y, br.y) - yMin) * tileSize;
    const pxSouth = (Math.max(tl.y, br.y) - yMin) * tileSize;

    const values = new Float32Array(grid * grid);
    let minE = Infinity;
    let maxE = -Infinity;

    for (let y = 0; y < grid; y++) {
      const ty = y / (grid - 1);
      const sy = pxNorth + (pxSouth - pxNorth) * ty;

      for (let x = 0; x < grid; x++) {
        const tx = x / (grid - 1);
        const sx = pxWest + (pxEast - pxWest) * tx;

        const v = nearestSample(stitched, stitchedW, stitchedH, sx, sy);
        values[y * grid + x] = v;
        minE = Math.min(minE, v);
        maxE = Math.max(maxE, v);
      }
    }

    /* ===================== CONTOURS ===================== */

    const start = Math.floor(minE / intervalM) * intervalM;
    const end = Math.ceil(maxE / intervalM) * intervalM;

    const thresholds: number[] = [];
    for (let t = start + intervalM; t <= end; t += intervalM) thresholds.push(t);

    const contourGen = d3Contours().size([grid, grid]).thresholds(thresholds);
    const features = contourGen(values);

    const pathGen = geoPath(geoIdentity());

    const scaleX = widthIn / (grid - 1);
    const scaleY = heightIn / (grid - 1);

    /* ===================== BUILD ZIP ===================== */

    const zip = new JSZip();
    const holes = addHoles ? alignmentHoles(widthIn, heightIn, holeDiameterIn, holeInsetIn) : "";

    let layerIndex = 1;

    for (const f of features) {
      const d = pathGen(f as any);
      if (!d) continue;

      const name = `layer_${String(layerIndex).padStart(3, "0")}_${Math.round((f as any).value)}m.svg`;
      const stroke = 0.001 / Math.max(scaleX, scaleY);

      const svg =
        svgHeader(widthIn, heightIn) +
        (holes ? holes + "\n" : "") +
        `<g transform="scale(${scaleX} ${scaleY})">
  <path d="${d}" fill="none" stroke="black" stroke-width="${stroke}" />
</g>
` +
        svgFooter();

      zip.file(name, svg);
      layerIndex++;
    }

    zip.file(
      "README.txt",
      [
        "Topo → Glowforge Export",
        `Min elevation: ${minE.toFixed(2)} m`,
        `Max elevation: ${maxE.toFixed(2)} m`,
        `Interval: ${intervalM} m`,
        `Grid: ${grid} x ${grid}`,
        `Layers: ${layerIndex - 1}`,
        "",
        "Each SVG is a silhouette slice.",
        "Set stroke to CUT in Glowforge.",
      ].join("\n")
    );

    /* ===================== RESPONSE ===================== */
    // KEY FIX: generate ArrayBuffer directly (avoids Uint8Array<ArrayBufferLike>/SharedArrayBuffer typings)
    const zipArrayBuffer = await zip.generateAsync({ type: "arraybuffer" });

    return new Response(zipArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="topo_layers.zip"`,
      },
    });
  } catch (err: any) {
    return new Response(`Export failed: ${err?.message ?? err}`, { status: 500 });
  }
}
