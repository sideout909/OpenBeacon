import * as maplibre from "maplibre-gl";
const palette = (isDark: boolean) =>
  isDark
    ? {
        background: "#182521",
        earth: "#1b2b26",
        land: "#263b2e",
        water: "#173c48",
        road: "#728378",
        casing: "#30433b",
        buildings: "#374c41",
        text: "#c9d9cf",
        halo: "#1d2c27",
      }
    : {
        background: "#e7eee8",
        earth: "#e9eee8",
        land: "#d5e5d1",
        water: "#b5d7df",
        road: "#fff",
        casing: "#c8d0ca",
        buildings: "#cfd8d1",
        text: "#52665f",
        halo: "#f8fbf6",
      };
export function updateMapColors(map: maplibre.Map, isDark: boolean) {
  const p = palette(isDark);
  const props: [string, string, string][] = [
    ["background", "background-color", p.background],
    ...(["world", "regional"].flatMap((prefix) => [
      [`${prefix}-earth`, "fill-color", p.earth],
      [`${prefix}-land`, "fill-color", p.land],
      [`${prefix}-water`, "fill-color", p.water],
      [`${prefix}-roads-case`, "line-color", p.casing],
      [`${prefix}-roads`, "line-color", p.road],
      [`${prefix}-buildings`, "fill-color", p.buildings],
      [`${prefix}-street-names`, "text-color", p.text],
      [`${prefix}-street-names`, "text-halo-color", p.halo],
      [`${prefix}-places`, "text-color", p.text],
      [`${prefix}-places`, "text-halo-color", p.halo],
    ]) as [string, string, string][]),
    ["station-label", "text-color", p.text],
    ["station-label", "text-halo-color", p.halo],
  ];
  for (const [id, property, value] of props)
    if (map.getLayer(id))
      map.setPaintProperty(
        id,
        property as Parameters<typeof map.setPaintProperty>[1],
        value,
      );
}
export function addBasemap(
  map: maplibre.Map,
  isDark: boolean,
  id: string,
  url: string,
  minzoom: number,
  online = false,
) {
  map.addSource(id, {
    type: "vector",
    ...(online ? { tiles: [url], maxzoom: 12 } : { url }),
    attribution: "© OpenStreetMap contributors · Protomaps",
  });
  const p = palette(isDark);
  const before = map.getLayer("station-dot") ? "station-dot" : undefined;
  const layers: maplibre.AddLayerObject[] = [
    {
      id: `${id}-earth`,
      type: "fill",
      source: id,
      "source-layer": "earth",
      minzoom,
      paint: { "fill-color": p.earth },
    },
    {
      id: `${id}-land`,
      type: "fill",
      source: id,
      "source-layer": "landcover",
      minzoom,
      paint: { "fill-color": p.land, "fill-opacity": 0.7 },
    },
    {
      id: `${id}-water`,
      type: "fill",
      source: id,
      "source-layer": "water",
      minzoom,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": p.water },
    },
    {
      id: `${id}-roads-case`,
      type: "line",
      source: id,
      "source-layer": "roads",
      minzoom,
      paint: {
        "line-color": p.casing,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 5],
      },
    },
    {
      id: `${id}-roads`,
      type: "line",
      source: id,
      "source-layer": "roads",
      minzoom,
      paint: {
        "line-color": p.road,
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.3, 14, 3],
      },
    },
    {
      id: `${id}-buildings`,
      type: "fill",
      source: id,
      "source-layer": "buildings",
      minzoom: Math.max(13, minzoom),
      paint: { "fill-color": p.buildings },
    },
    {
      id: `${id}-street-names`,
      type: "symbol",
      source: id,
      "source-layer": "roads",
      minzoom: Math.max(13, minzoom),
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["has", "name"]],
      layout: {
        "symbol-placement": "line",
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 13],
        "text-max-angle": 30,
      },
      paint: {
        "text-color": p.text,
        "text-halo-color": p.halo,
        "text-halo-width": 1.3,
      },
    },
    {
      id: `${id}-places`,
      type: "symbol",
      source: id,
      "source-layer": "places",
      minzoom,
      filter: ["has", "name"],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 10, 10, 13],
        "text-optional": true,
      },
      paint: {
        "text-color": p.text,
        "text-halo-color": p.halo,
        "text-halo-width": 1.3,
      },
    },
  ];
  for (const layer of layers) map.addLayer(layer, before);
}
const suffixes = [
  "earth",
  "land",
  "water",
  "roads-case",
  "roads",
  "buildings",
  "street-names",
  "places",
];
export function removeBasemap(map: maplibre.Map, id: string) {
  for (const suffix of suffixes) {
    const key = `${id}-${suffix}`;
    if (map.getLayer(key)) map.removeLayer(key);
  }
  if (map.getSource(id)) map.removeSource(id);
}
