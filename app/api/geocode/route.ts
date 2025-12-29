import { NextResponse } from "next/server";

/**
 * Free geocoding via Nominatim (OpenStreetMap).
 * Important: be nice with rate limits. For an MVP, this is fine.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();

  if (!q) return new NextResponse("Missing q", { status: 400 });

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  // Nominatim wants a real User-Agent / Referer; Next's fetch may omit a nice UA,
  // so we set headers explicitly.
  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "TopoGlowforgeMVP/1.0 (local dev)",
      "Accept-Language": "en",
      "Referer": "http://localhost",
    },
    // Slight caching is fine
    cache: "no-store",
  });

  if (!res.ok) {
    return new NextResponse(`Geocode failed: ${res.status}`, { status: 502 });
  }

  const json: any[] = await res.json();
  if (!json.length) return new NextResponse("No results", { status: 404 });

  const first = json[0];
  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!isFinite(lat) || !isFinite(lon)) return new NextResponse("Bad result", { status: 502 });

  return NextResponse.json({
    center: { lat, lon },
    label: first.display_name,
  });
}
