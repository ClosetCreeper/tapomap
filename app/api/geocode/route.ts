import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return new NextResponse("Missing q", { status: 400 });

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "TopoGlowforge/1.0",
      "Accept-Language": "en",
      "Referer": "https://example.com"
    },
    cache: "no-store"
  });

  if (!res.ok) return new NextResponse(`Geocode failed: ${res.status}`, { status: 502 });

  const json: any[] = await res.json();
  if (!json.length) return new NextResponse("No results", { status: 404 });

  const first = json[0];
  const lat = Number(first.lat);
  const lon = Number(first.lon);

  return NextResponse.json({
    center: { lat, lon },
    label: first.display_name
  });
}
