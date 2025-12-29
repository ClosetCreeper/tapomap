"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { Map } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

type Bounds = { west: number; south: number; east: number; north: number };

export default function Home() {
  const mapRef = useRef<Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement | null>(null);

  const [bounds, setBounds] = useState<Bounds | null>(null);

  // Search
  const [query, setQuery] = useState("Big Cottonwood Canyon");
  const [searchStatus, setSearchStatus] = useState("");

  // Export settings
  const [widthIn, setWidthIn] = useState(20);
  const [heightIn, setHeightIn] = useState(12);
  const [intervalM, setIntervalM] = useState(30);
  const [grid, setGrid] = useState(256);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [-111.7, 40.65],
      zoom: 10.5,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    const updateBounds = () => {
      const b = map.getBounds();
      setBounds({
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      });
    };

    map.on("moveend", updateBounds);
    map.on("load", updateBounds);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  async function doSearch() {
    const map = mapRef.current;
    if (!map) return;
    const q = query.trim();
    if (!q) return;

    setSearchStatus("Searching…");
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();

      if (!data?.center) throw new Error("No results");
      const { lon, lat } = data.center;

      map.easeTo({ center: [lon, lat], zoom: 11.5, duration: 900 });
      setSearchStatus(data.label ? `Found: ${data.label}` : "Found!");
    } catch (e: any) {
      setSearchStatus(`No luck: ${e?.message ?? e}`);
    }
  }

  async function exportTopo() {
  if (!bounds) return;

  setBusy(true);
  setStatus("Exporting…");

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bounds,
        widthIn,
        heightIn,
        intervalM,
        grid,
        addAlignmentHoles: true,
        holeDiameterIn: 0.125,
        holeInsetIn: 0.35,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "topo_layers.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
    setStatus("Downloaded topo_layers.zip");
  } catch (e: any) {
    setStatus(`Export failed: ${e?.message ?? e}`);
  } finally {
    setBusy(false);
  }
}


  return (
    <div style={{ display: "grid", gridTemplateColumns: "420px 1fr", height: "100vh" }}>
      <div style={{ padding: 16, borderRight: "1px solid #ddd", overflow: "auto" }}>
        <h1 style={{ margin: 0 }}>Topo → Glowforge</h1>
        <p style={{ marginTop: 8, color: "#555" }}>
          Pan/zoom to frame your area. Export uses the <b>current viewport</b>.
        </p>

        {/* Search */}
        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Search place</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doSearch();
              }}
              placeholder="e.g. Big Cottonwood Canyon"
              style={{ width: "100%" }}
            />
            <button onClick={doSearch} style={{ fontWeight: 700 }}>
              Go
            </button>
          </div>
          <small style={{ color: "#666" }}>{searchStatus}</small>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Output size (inches)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="number"
              value={widthIn}
              onChange={(e) => setWidthIn(Number(e.target.value))}
              min={1}
              step={0.1}
              style={{ width: "100%" }}
            />
            <span style={{ alignSelf: "center" }}>×</span>
            <input
              type="number"
              value={heightIn}
              onChange={(e) => setHeightIn(Number(e.target.value))}
              min={1}
              step={0.1}
              style={{ width: "100%" }}
            />
          </div>
          <small style={{ color: "#666" }}>Glowforge Pro bed is 20×12.</small>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Contour interval (meters per layer)</label>
          <input
            type="number"
            value={intervalM}
            onChange={(e) => setIntervalM(Number(e.target.value))}
            min={1}
            step={1}
            style={{ width: "100%" }}
          />
          <small style={{ color: "#666" }}>Lower interval = more layers.</small>
        </div>

        <div style={{ marginTop: 14 }}>
          <label style={{ display: "block", marginBottom: 6 }}>Sampling grid</label>
          <select value={grid} onChange={(e) => setGrid(Number(e.target.value))} style={{ width: "100%" }}>
            <option value={128}>128×128 (fast)</option>
            <option value={256}>256×256 (good)</option>
            <option value={512}>512×512 (slow)</option>
          </select>
          <small style={{ color: "#666" }}>Higher grid = more detail, heavier SVGs.</small>
        </div>

        <button
          onClick={exportTopo}
          disabled={!bounds || busy}
          style={{ marginTop: 16, width: "100%", padding: "10px 12px", fontWeight: 700 }}
        >
          {busy ? "Exporting…" : "Export SVG Layers (ZIP)"}
        </button>

        <div style={{ marginTop: 12, fontSize: 13, color: "#444" }}>{status}</div>

        <hr style={{ margin: "16px 0" }} />

        <div style={{ fontSize: 13, color: "#444" }}>
          <b>Current bounds</b>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {bounds ? JSON.stringify(bounds, null, 2) : "Loading…"}
          </pre>
        </div>
      </div>

      <div style={{ position: "relative" }}>
        <div ref={mapDivRef} style={{ position: "absolute", inset: 0 }} />

        {/* Frame overlay */}
        <div
          style={{
            position: "absolute",
            inset: 24,
            border: "3px solid rgba(0,0,0,0.65)",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.15)",
            pointerEvents: "none",
            borderRadius: 8,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 32,
            bottom: 24,
            background: "rgba(255,255,255,0.92)",
            padding: "6px 10px",
            borderRadius: 10,
            fontSize: 12,
            border: "1px solid rgba(0,0,0,0.15)",
          }}
        >
          Export frame = viewport (inside the dark border)
        </div>
      </div>
    </div>
  );
}
