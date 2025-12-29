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

// Terrarium decode: (R*256 + G + B/256) - 32768
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

function circlesForAlignment(
  widthIn: number,
  heightIn: number,
  holeDiameterIn: number,
  holeInsetIn: number
) {
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

    if (
      !bounds ||
      !isFinite(widthIn) ||
      !isFinite(heightIn) ||
      widthIn <= 0 ||
      heightIn <= 0 ||
      !isFinite(intervalM) ||
      intervalM <= 0 ||
      !isFinite(grid) ||
      grid < 64
    ) {
      return new NextResponse("Bad request", { status: 400 });
    }

    // MVP zoom. If you zoom way out, too many tiles will be needed; we’ll block that.
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
        `Selection too large at this zoom (needs ${tileCount} elevation tiles). Zoom in more.`,
        { status: 413 }
      );
    }

    // Fetch and stitch elevation tiles (Terrarium format)
    // Source: AWS Terrain Tiles (public) terrarium PNG
    const tileSize = 256;
    const stitchedW = (xMax - xMin + 1) * tileSize;
    const stitchedH = (yMax - yMin + 1) * tileSize;

    const stitched = new Float32Array(stitchedW * stitchedH);

    for (let ty = yMin; ty <= yMax; ty++) {
      for (let tx = xMin; tx <= xMax; tx++) {
        // IMPORTANT: keep this as a template; if this specific hostname ever changes,
        // swap in another public Terrarium tile provider.
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;

        const png = await fetchPng(url);
        // png.data is RGBA
        for (let py = 0; py < tileSize; py++) {
          for (let px = 0; px < tileSize; px++) {
            const si = (py * tileSize + px) * 4;
            const r = png.data[si];
            const g = png.data[si + 1];
            const b = png.data[si + 2];

            const elev = decodeTerrarium(r, g, b);

            const gx = (tx - xMin) * tileSize + px;
            const gy = (ty - yMin) * tileSize + py;
            stitched[gy * stitchedW + gx] = elev;
          }
        }
      }
    }

    // Convert selection bounds (fractional tile coords) into pixel coordinates in stitched space
    const pxWest = (Math.min(tl.x, br.x) - xMin) * tileSize;
    const pxEast = (Math.max(tl.x, br.x) - xMin) * tileSize;
    const pxNorth = (Math.min(tl.y, br.y) - yMin) * tileSize;
    const pxSouth = (Math.max(tl.y, br.y) - yMin) * tileSize;

    // Sample stitched elevation into a square grid (grid x grid) for contouring
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

    // Build contour thresholds
    const start = Math.floor(minE / intervalM) * intervalM;
    const end = Math.ceil(maxE / intervalM) * intervalM;

    const thresholds: number[] = [];
    for (let t = start + intervalM; t <= end; t += intervalM) thresholds.push(t);

    if (!thresholds.length) {
      return new NextResponse("No layers generated (try smaller interval).", { status: 400 });
    }

    // Generate contour polygons (MultiPolygon)
    const contourGen = d3Contours()
      .size([grid, grid])
      .thresholds(thresholds);

    const contourFeatures = contourGen(values);

    // Prep SVG path generator in grid-space
    const proj = geoIdentity();
    const pathGen = geoPath(proj);

    // We will scale grid coordinates into inches by wrapping with <g transform="scale(...)">
    const scaleX = widthIn / (grid - 1);
    const scaleY = heightIn / (grid - 1);

    // ZIP output
    const zip = new JSZip();

    // Optional: alignment holes in inch-space (outside scaled group)
    const holeSvg = addAlignmentHoles
      ? circlesForAlignment(widthIn, heightIn, holeDiameterIn, holeInsetIn)
      : "";

    // For each threshold, create a “solid slice”: everything above that height.
    // d3-contour gives us polygons for each threshold separately; for stacked slices,
    // each layer’s contour is already the boundary of values >= threshold.
    // Perfect for cutting layer silhouettes.
    for (let idx = 0; idx < contourFeatures.length; idx++) {
      const f: any = contourFeatures[idx];
      const level = f.value; // threshold
      const d = pathGen(f);

      // Some layers might be empty
      if (!d) continue;

      const layerNumber = String(idx + 1).padStart(3, "0");
      const name = `layer_${layerNumber}_${Math.round(level)}m.svg`;

      const svg =
        svgHeader(widthIn, heightIn) +
        (holeSvg ? `  ${holeSvg}\n` : "") +
        `  <g transform="scale(${scaleX} ${scaleY})">\n` +
        `    <path d="${d}" fill="none" stroke="black" stroke-width="${0.001 / Math.max(scaleX, scaleY)}"/>\n` +
        `  </g>\n` +
        svgFooter();

      zip.file(name, svg);
    }

    // Add a small text summary file
    zip.file(
      "README.txt",
      [
        "Topo → Glowforge export",
        `Min elevation: ${minE.toFixed(2)} m`,
        `Max elevation: ${maxE.toFixed(2)} m`,
        `Interval: ${intervalM} m`,
        `Grid: ${grid} x ${grid}`,
        "",
        "Each SVG is a silhouette slice (everything ABOVE the layer elevation).",
        "Import into Glowforge as CUT (stroke lines).",
      ].join("\n")
    );

    const zipBuf = await zip.generateAsync({ type: "nodebuffer" });

    return new NextResponse(zipBuf, {
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
