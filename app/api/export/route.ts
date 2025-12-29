import { NextResponse } from "next/server";
import JSZip from "jszip";
import { PNG } from "pngjs";
import { contours as d3Contours } from "d3-contour";
import { geoIdentity, geoPath } from "d3-geo";

type Bounds = { west: number; south: number; east: number; north: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

// Terrarium: (R*256 + G + B/256) - 32768
function decodeTerrarium(r: number, g: number, b: number) {
  return r * 256 + g + b / 256 - 32768;
}

async function fetchPng(url: string): Promise<PNG> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Tile fetch failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return PNG.sync.read(buf);
}

function nearestSample(src: Float32Array, srcW: number, srcH: number, x: number, y: number) {
  const ix = clamp(Math.round(x), 0, srcW - 1);
  const iy = clamp(Math.round(y), 0, srcH - 1);
  return src[iy * srcW + ix];
}

function svgHeader(widthIn: number, heightIn: number) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
  width="${widthIn}in" height="${heightIn}in"
  viewBox="0 0 ${widthIn} ${heightIn}">
`;
}
function svgFooter() {
  return `</svg>\n`;
}

function circlesForAlignment(widthIn: number, heightIn: number, holeDiameterIn: number, holeInsetIn: number) {
  const r = holeDiameterIn / 2;
  const pts = [
    [holeInsetIn, holeInsetIn],
    [widthIn - holeInsetIn, holeInsetIn],
    [holeInsetIn, heightIn - holeInsetIn],
    [widthIn - holeInsetIn, heightIn - holeInsetIn],
  ];
  return pts
    .map(
      ([cx, cy]) =>
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="black" stroke-width="0.001"/>`
    )
    .join("\n");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const bounds: Bounds = body.bounds;
    const widthIn = Number(body.widthIn ?? 20);
    const heightIn = Number(body.heightIn ?? 12);
    const intervalM = Number(body.intervalM ?? 30);
    const grid = Number(body.grid ?? 256);

    const addAlignmentHoles = Boolean(body.addAlignmentHoles ?? true);
    const holeDiameterIn = Number(body.holeDiameterIn ?? 0.125);
    const holeInsetIn = Number(body.holeInsetIn ?? 0.35);

    if (!bounds || widthIn <= 0 || heightIn <= 0 || intervalM <= 0 || grid < 64) {
      return new NextResponse("Bad request", { status: 400 });
    }

    // Keep MVP simple: fixed zoom.
    // If you want: we can auto-pick zoom later.
    const z = 12;

    const tl = lonLatToTile(bounds.west, bounds.north, z);
    const br = lonLatToTile(bounds.east, bounds.south, z);

    const xMin = Math.floor(Math.min(tl.x, br.x));
    const xMax = Math.floor(Math.max(tl.x, br.x));
    const yMin = Math.floor(Math.min(tl.y, br.y));
    const yMax = Math.floor(Math.max(tl.y, br.y));

    const tileCount = (xMax - xMin + 1) * (yMax - yMin + 1);
    if (tileCount > 64) {
      return new NextResponse(
        `Selection too large (needs ${tileCount} elevation tiles). Zoom in more.`,
        { status: 413 }
      );
    }

    // Stitch Terrarium elevation tiles into one raster
    const tileSize = 256;
    const stitchedW = (xMax - xMin + 1) * tileSize;
    const stitchedH = (yMax - yMin + 1) * tileSize;
    const stitched = new Float32Array(stitchedW * stitchedH);

    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        // Free public terrarium tiles (AWS). If this ever changes, we can swap providers.
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
        const png = await fetchPng(url);

        for (let py = 0; py < tileSize; py++) {
          for (let px = 0; px < tileSize; px++) {
            const si = (py * tileSize + px) * 4;
            const elev = decodeTerrarium(png.data[si], png.data[si + 1], png.data[si + 2]);

            const gx = (tx - xMin) * tileSize + px;
            const gy = (ty - yMin) * tileSize + py;
            stitched[gy * stitchedW + gx] = elev;
          }
        }
      }
    }

    // Pixel-space rectangle within stitched raster for the exact viewport bounds
    const pxWest = (Math.min(tl.x, br.x) - xMin) * tileSize;
    const pxEast = (Math.max(tl.x, br.x) - xMin) * tileSize;
    const pxNorth = (Math.min(tl.y, br.y) - yMin) * tileSize;
    const pxSouth = (Math.max(tl.y, br.y) - yMin) * tileSize;

    // Sample into grid x grid for contouring
    const values = new Float32Array(grid * grid);
    let minE = Infinity;
    let maxE = -Infinity;

    for (let j = 0; j < grid; j++) {
      const tY = j / (grid - 1);
      const sy = pxNorth + (pxSouth - pxNorth) * tY;

      for (let i = 0; i < grid; i++) {
        const tX = i / (grid - 1);
        const sx = pxWest + (pxEast - pxWest) * tX;

        const v = nearestSample(stitched, stitchedW, stitchedH, sx, sy);
        values[j * grid + i] = v;
        if (v < minE) minE = v;
        if (v > maxE) maxE = v;
      }
    }

    if (!isFinite(minE) || !isFinite(maxE) || maxE <= minE) {
      return new NextResponse("Elevation data invalid for this area.", { status: 502 });
    }

    // Thresholds = one silhouette slice per interval
    const start = Math.floor(minE / intervalM) * intervalM;
    const end = Math.ceil(maxE / intervalM) * intervalM;

    const thresholds: number[] = [];
    for (let t = start + intervalM; t <= end; t += intervalM) thresholds.push(t);

    if (!thresholds.length) {
      return new NextResponse("No layers produced. Try a smaller interval.", { status: 400 });
    }

    const contourGen = d3Contours().size([grid, grid]).thresholds(thresholds);
    const contourFeatures = contourGen(values);

    const proj = geoIdentity();
    const pathGen = geoPath(proj);

    // scale grid coords → inches
    const scaleX = widthIn / (grid - 1);
    const scaleY = heightIn / (grid - 1);

    const zip = new JSZip();
    const holes = addAlignmentHoles ? circlesForAlignment(widthIn, heightIn, holeDiameterIn, holeInsetIn) : "";

    let written = 0;

    for (let idx = 0; idx < contourFeatures.length; idx++) {
      const f: any = contourFeatures[idx];
      const level = f.value;
      const d = pathGen(f);
      if (!d) continue;

      const layerNumber = String(idx + 1).padStart(3, "0");
      const name = `layer_${layerNumber}_${Math.round(level)}m.svg`;

      // Stroke width corrected for the scaling transform
      const stroke = 0.001 / Math.max(scaleX, scaleY);

      const svg =
        svgHeader(widthIn, heightIn) +
        (holes ? `  ${holes}\n` : "") +
        `  <g transform="scale(${scaleX} ${scaleY})">\n` +
        `    <path d="${d}" fill="none" stroke="black" stroke-width="${stroke}"/>\n` +
        `  </g>\n` +
        svgFooter();

      zip.file(name, svg);
      written++;
    }

    zip.file(
      "README.txt",
      [
        "Topo → Glowforge export",
        `Min elevation: ${minE.toFixed(2)} m`,
        `Max elevation: ${maxE.toFixed(2)} m`,
        `Interval: ${intervalM} m`,
        `Grid: ${grid} x ${grid}`,
        `Layers written: ${written}`,
        "",
        "Each SVG is a silhouette slice (everything ABOVE the layer elevation).",
        "In Glowforge: set black stroke to CUT.",
      ].join("\n")
    );

    // IMPORTANT: return Uint8Array so NextResponse is happy on Vercel
    const zipBytes = await zip.generateAsync({ type: "uint8array" });

    return new Response(zipBytes, {
      status: 200,
      headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="topo_layers.zip"`,
    },
  });


  } catch (e: any) {
    return new NextResponse(`Export error: ${e?.message ?? e}`, { status: 500 });
  }
}
