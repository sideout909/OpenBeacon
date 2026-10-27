import { identifyDevice } from "./device-id";
import { addBasemap, removeBasemap, updateMapColors } from "./basemap";
import { appShell } from "./shell";
import * as maplibre from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { Protocol, PMTiles, FileSource } from "pmtiles";
import { desktop, type ConnectionSettings, type Theme } from "./desktop";
import { StationStore } from "./stations";
import { MessageInbox } from "./messages";
import { showPacket } from "./packet-view";
import { type DecodedPacket, sourceLabel } from "./aprs";
import { symbolCells } from "./symbols";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

function startApp() {
  maplibre.setWorkerUrl(new URL(mapWorkerUrl, document.baseURI).href);
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = appShell;
  const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  let theme: Theme = "system";
  const isDark = () =>
    theme === "dark" || (theme === "system" && systemTheme.matches);
  function applyTheme() {
    document.documentElement.dataset.theme = isDark() ? "dark" : "light";
    if (map.isStyleLoaded()) updateMapColors(map, isDark());
    else map.once("idle", () => updateMapColors(map, isDark()));
  }
  systemTheme.addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });
  const savedView = (() => {
    try {
      return JSON.parse(localStorage.getItem("openbeacon-view") || "{}");
    } catch {
      return {};
    }
  })();
  const protocol = new Protocol();
  maplibre.addProtocol("pmtiles", protocol.tile);
  const map = new maplibre.Map({
    container: "map",
    center:
      Array.isArray(savedView.center) &&
      savedView.center.length === 2 &&
      savedView.center.every(Number.isFinite)
        ? savedView.center
        : [-83.0458, 42.3314],
    zoom: Number.isFinite(savedView.zoom)
      ? Math.max(0, Math.min(20, savedView.zoom))
      : 9,
    attributionControl: false,
    style: {
      version: 8,
      glyphs: `${new URL("fonts/", document.baseURI).href}{fontstack}/{range}.pbf`,
      sources: {},
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#172520" },
        },
      ],
    },
  });
  map.addControl(
    new maplibre.NavigationControl({ showCompass: true, visualizePitch: true }),
    "top-right",
  );
  map.addControl(
    new maplibre.ScaleControl({ maxWidth: 120, unit: "imperial" }),
    "bottom-left",
  );
  map.on("mousemove", (e) => {
    el("coordinates").textContent =
      `${e.lngLat.lat.toFixed(4)}°, ${e.lngLat.lng.toFixed(4)}° · zoom ${map.getZoom().toFixed(1)}`;
  });
  map.on("moveend", () =>
    localStorage.setItem(
      "openbeacon-view",
      JSON.stringify({
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
      }),
    ),
  );
  map.on("error", (e) => {
    console.error(e.error);
    el("map-message").textContent = `Map: ${e.error.message}`;
    el("map-message").hidden = false;
  });
  const stationStore = new StationStore();
  const mapStationStore = new StationStore();
  let mapCleared = false;
  const stations = stationStore.stations;
  const tracksOn = el<HTMLInputElement>("show-tracks");
  const ageOn = el<HTMLInputElement>("limit-station-age");
  const ageInput = el<HTMLInputElement>("station-age");
  tracksOn.checked = localStorage.getItem("openbeacon-tracks") !== "false";
  ageOn.checked = localStorage.getItem("openbeacon-age-enabled") === "true";
  const savedAge = Number(localStorage.getItem("openbeacon-age-minutes"));
  if (Number.isInteger(savedAge) && savedAge >= 1 && savedAge <= 10080)
    ageInput.value = String(savedAge);
  let maxAgeMinutes = Number(ageInput.value);
  function visibleStation(heardAt: number) {
    return !ageOn.checked || Date.now() - heardAt <= maxAgeMinutes * 60000;
  }
  tracksOn.onchange = () => {
    localStorage.setItem("openbeacon-tracks", String(tracksOn.checked));
    dirty = true;
  };
  ageOn.onchange = () => {
    localStorage.setItem("openbeacon-age-enabled", String(ageOn.checked));
    dirty = true;
  };
  ageInput.onchange = () => {
    if (ageInput.reportValidity() && ageInput.value) {
      maxAgeMinutes = Number(ageInput.value);
      localStorage.setItem("openbeacon-age-minutes", ageInput.value);
      dirty = true;
    } else ageInput.value = String(maxAgeMinutes);
  };
  setInterval(() => {
    if (ageOn.checked) dirty = true;
  }, 15000);
  let selected: string | null = null;
  let dirty = false;
  let recent: DecodedPacket[] = [];
  let sentPacket: { raw: string; until: number } | null = null;
  let heldRf: { packet: DecodedPacket; until: number }[] = [];
  const rfHighlights = new Map<
    string,
    { marker: maplibre.Marker; timer: ReturnType<typeof setTimeout> }
  >();
  el("clear-map").onclick = () => {
    mapCleared = true;
    mapStationStore.stations.clear();
    mapStationStore.tracks.clear();
    for (const { marker, timer } of rfHighlights.values()) {
      clearTimeout(timer);
      marker.remove();
    }
    rfHighlights.clear();
    dirty = true;
  };
  function highlightRfStation(packet: DecodedPacket) {
    const call = packet.source.toUpperCase();
    const station = stations.get(call);
    if (!station || !visibleStation(station.heardAt)) return;
    const old = rfHighlights.get(call);
    if (old) {
      clearTimeout(old.timer);
      old.marker.remove();
      rfHighlights.delete(call);
    }
    if (rfHighlights.size >= 100) {
      const first = rfHighlights.keys().next().value;
      if (first !== undefined) {
        const item = rfHighlights.get(first)!;
        clearTimeout(item.timer);
        item.marker.remove();
        rfHighlights.delete(first);
      }
    }
    const element = document.createElement("div");
    element.className = "rf-highlight-anchor";
    element.setAttribute("aria-hidden", "true");
    const ring = document.createElement("div");
    ring.className = "rf-station-highlight";
    element.append(ring);
    const marker = new maplibre.Marker({ element, anchor: "center" })
      .setLngLat([station.longitude, station.latitude])
      .addTo(map);
    const timer = setTimeout(() => {
      marker.remove();
      rfHighlights.delete(call);
    }, 4500);
    rfHighlights.set(call, { marker, timer });
  }
  function holdRf(packet: DecodedPacket) {
    const until = Date.now() + 10000;
    heldRf = [
      { packet, until },
      ...heldRf.filter((item) => item.until > Date.now()),
    ].slice(0, 2);
    setTimeout(() => {
      heldRf = heldRf.filter((item) => item.until > Date.now());
      renderPackets();
    }, 10050);
  }
  function showSentPacket(raw: string) {
    sentPacket = { raw, until: Date.now() + 10000 };
    renderPackets();
    setTimeout(() => {
      if (sentPacket && Date.now() >= sentPacket.until) {
        sentPacket = null;
        renderPackets();
      }
    }, 10050);
  }
  const receivedMessages = new MessageInbox();
  const weatherPackets = new Map<string, DecodedPacket>();
  let monitorPackets: DecodedPacket[] = [];
  let monitorSnapshot: DecodedPacket[] | null = null;
  let monitorWhilePaused = 0;
  const packetDialog = el<HTMLDialogElement>("packet-dialog");
  el("close-packet").onclick = () => packetDialog.close();
  const inspectPacket = (packet: DecodedPacket) =>
    showPacket(packetDialog, el("packet-detail-content"), packet);
  let symbolSheets: HTMLImageElement[] | null = null;
  const missingSymbols = new Set<string>();
  function stationIcon(symbol: string): string | null {
    const cells = symbolCells(symbol);
    if (!cells || !symbolSheets) return null;
    const id = `aprs-${cells.table}-${cells.index}-${cells.overlay ?? "none"}`;
    if (map.hasImage(id)) return id;
    if (missingSymbols.has(id)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    const draw = (sheet: HTMLImageElement, index: number) =>
      context.drawImage(
        sheet,
        (index % 16) * 48,
        Math.floor(index / 16) * 48,
        48,
        48,
        0,
        0,
        48,
        48,
      );
    draw(symbolSheets[cells.table], cells.index);
    const base = context.getImageData(0, 0, 48, 48);
    if (!base.data.some((value, index) => index % 4 === 3 && value > 0)) {
      missingSymbols.add(id);
      return null;
    }
    if (cells.overlay !== undefined) draw(symbolSheets[2], cells.overlay);
    map.addImage(id, context.getImageData(0, 0, 48, 48), { pixelRatio: 2 });
    return id;
  }
  async function loadSymbolSheets() {
    try {
      symbolSheets = await Promise.all(
        [0, 1, 2].map(
          (index) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.onerror = () =>
                reject(new Error(`Could not load APRS symbol sheet ${index}`));
              image.src = new URL(
                `aprs-symbols/table-${index}.png`,
                document.baseURI,
              ).href;
            }),
        ),
      );
      dirty = true;
    } catch (error) {
      console.error(error);
    }
  }
  function stationData(): GeoJSON.FeatureCollection<GeoJSON.Point> {
    return {
      type: "FeatureCollection",
      features: [...mapStationStore.stations.values()]
        .filter((s) => visibleStation(s.heardAt))
        .map((s) => {
          const icon = stationIcon(s.symbol);
          return {
            type: "Feature",
            id: s.callsign,
            properties: {
              callsign: s.callsign,
              symbol: s.symbol,
              icon: icon ?? "",
              hasIcon: !!icon,
            },
            geometry: { type: "Point", coordinates: [s.longitude, s.latitude] },
          };
        }),
    };
  }
  function trackData(): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    return {
      type: "FeatureCollection",
      features: tracksOn.checked
        ? [...mapStationStore.tracks.entries()].flatMap(([call, points]) => {
            const station = mapStationStore.stations.get(call);
            return station &&
              visibleStation(station.heardAt) &&
              points.length >= 2
              ? [
                  {
                    type: "Feature" as const,
                    properties: { callsign: call },
                    geometry: {
                      type: "LineString" as const,
                      coordinates: points,
                    },
                  },
                ]
              : [];
          })
        : [],
    };
  }
  function addStationLayers() {
    map.addSource("tracks", { type: "geojson", data: trackData() });
    map.addLayer({
      id: "station-tracks",
      type: "line",
      source: "tracks",
      paint: { "line-color": "#16a28e", "line-width": 2, "line-opacity": 0.7 },
    });
    map.addSource("stations", { type: "geojson", data: stationData() });
    map.addLayer({
      id: "station-dot",
      type: "circle",
      source: "stations",
      filter: ["==", ["get", "hasIcon"], false],
      paint: {
        "circle-radius": 6,
        "circle-color": "#25bda6",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff",
      },
    });
    map.addLayer({
      id: "station-icon",
      type: "symbol",
      source: "stations",
      filter: ["==", ["get", "hasIcon"], true],
      layout: { "icon-image": ["get", "icon"], "icon-allow-overlap": true },
    });
    map.addLayer({
      id: "station-label",
      type: "symbol",
      source: "stations",
      minzoom: 6,
      layout: {
        "text-field": ["get", "callsign"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
        "text-offset": [0, 1.7],
        "text-anchor": "top",
        "text-optional": true,
      },
      paint: {
        "text-color": isDark() ? "#e4f2eb" : "#203c36",
        "text-halo-color": isDark() ? "#172722" : "#f6faf5",
        "text-halo-width": 1.5,
      },
    });
  }
  setInterval(() => {
    if (dirty && map.getSource("stations")) {
      (map.getSource("stations") as maplibre.GeoJSONSource).setData(
        stationData(),
      );
      const tracks = map.getSource("tracks") as
        maplibre.GeoJSONSource | undefined;
      tracks?.setData(trackData());
      dirty = false;
    }
  }, 500);
  function updateDetails() {
    if (!selected) return;
    const s = stations.get(selected);
    if (!s) return;
    el("station-name").textContent = s.callsign;
    const fields: [string, string][] = [
      ["Source", sourceLabel(s.source)],
      [
        "Device / application",
        identifyDevice(s.packet.destination, s.packet.kind) ?? "Unknown",
      ],
      ["Last received", new Date(s.heardAt).toLocaleString()],
      ["Position", `${s.latitude.toFixed(4)}°, ${s.longitude.toFixed(4)}°`],
      ["Symbol", s.symbol],
      ["Position type", s.kind.replaceAll("_", " ")],
      [
        "Precision",
        s.ambiguity
          ? `Approximate · ${s.ambiguity} ambiguous digits`
          : "As reported",
      ],
      ["Speed", s.speedKnots == null ? "—" : `${s.speedKnots} kt`],
      ["Course", s.courseDegrees == null ? "—" : `${s.courseDegrees}°`],
      ["Comment", s.comment || "—"],
      [
        "Temperature",
        s.weather?.temperatureFahrenheit == null
          ? "—"
          : `${s.weather.temperatureFahrenheit} °F`,
      ],
      [
        "Humidity",
        s.weather?.humidityPercent == null
          ? "—"
          : `${s.weather.humidityPercent}%`,
      ],
      ["Warnings", s.warnings.join("; ") || "—"],
    ];
    const root = el("station-details");
    root.replaceChildren(
      ...fields.map(([name, value]) => {
        const row = document.createElement("div");
        row.className = "detail-row";
        const label = document.createElement("span");
        label.textContent = name;
        const content = document.createElement("strong");
        content.textContent = value;
        row.append(label, content);
        return row;
      }),
    );
  }
  function renderStations() {
    if (el("stations-panel").hidden) return;
    const query = el<HTMLInputElement>("station-search")
      .value.trim()
      .toUpperCase();
    const rfOnly = el<HTMLInputElement>("station-source").checked;
    const matches = [...stations.values()]
      .reverse()
      .filter(
        (station) =>
          (!rfOnly || station.source === "rf") &&
          station.callsign.includes(query),
      );
    const root = el("stations-list");
    el("stations-summary").textContent =
      rfOnly &&
      ![...stations.values()].some((station) => station.source === "rf")
        ? "No RF station positions received yet."
        : stations.size === 0
          ? "No station positions received yet. Connect APRS-IS to see live stations."
          : matches.length === 0
            ? "No matching callsigns."
            : `${matches.length.toLocaleString()} of ${stations.size.toLocaleString()} stations · ${matches.length > 200 ? "showing the 200 most recent · refine search" : "most recently received first"}`;
    root.replaceChildren();
    for (const station of matches.slice(0, 200)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "station-list-item";
      button.setAttribute(
        "aria-pressed",
        String(selected === station.callsign),
      );
      const name = document.createElement("strong");
      name.textContent = station.callsign;
      const info = document.createElement("span");
      info.textContent = `${sourceLabel(station.source)} · ${new Date(station.heardAt).toLocaleString()}`;
      button.append(name, info);
      button.onclick = () => {
        selectStation(station.callsign);
        map.flyTo({
          center: [station.longitude, station.latitude],
          essential: true,
        });
      };
      root.append(button);
    }
  }
  function selectStation(call: string) {
    if (!stations.has(call)) return;
    selected = call;
    el("details").hidden = false;
    updateDetails();
    renderStations();
    map.resize();
  }
  function showStations(show: boolean) {
    el("messages-panel").hidden = true;
    el("weather-panel").hidden = true;
    el("packets-panel").hidden = true;
    el("packets-button").classList.remove("active");
    el("weather-button").classList.remove("active");
    el("messages-button").classList.remove("active");
    el("stations-panel").hidden = !show;
    el("stations-button").classList.toggle("active", show);
    el("map-button").classList.toggle("active", !show);
    renderStations();
    map.resize();
    if (show) el<HTMLInputElement>("station-search").focus();
  }
  function renderMessages() {
    const identity = savedCallsign.trim().toUpperCase();
    const messages = receivedMessages.forIdentity(identity);
    el("message-summary").textContent = !identity
      ? "Set your callsign and SSID in My Station to see messages addressed to you."
      : messages.length
        ? `${messages.length} received for ${identity}`
        : `No messages received for ${identity} this session.`;
    const list = el("message-list");
    list.replaceChildren();
    for (const packet of messages) {
      const item = document.createElement("article");
      item.className = "message-item";
      const heading = document.createElement("strong");
      heading.textContent = `From ${packet.source || "Unknown"} · To ${packet.message!.addressee}`;
      const meta = document.createElement("div");
      meta.className = "message-note";
      meta.textContent = `${sourceLabel(packet.origin)} · ${new Date(packet.receivedAt).toLocaleString()}${packet.message!.id ? ` · ID ${packet.message!.id}` : ""}`;
      const body = document.createElement("p");
      body.textContent = packet.message!.text;
      const inspect = document.createElement("button");
      inspect.type = "button";
      inspect.textContent = "View packet";
      inspect.onclick = () => inspectPacket(packet);
      item.append(heading, meta, body, inspect);
      list.append(item);
    }
  }
  el("messages-button").onclick = () => {
    el("stations-panel").hidden = true;
    el("weather-panel").hidden = true;
    el("packets-panel").hidden = true;
    el("packets-button").classList.remove("active");
    el("weather-button").classList.remove("active");
    el("messages-panel").hidden = false;
    el("stations-button").classList.remove("active");
    el("map-button").classList.remove("active");
    el("messages-button").classList.add("active");
    renderMessages();
    map.resize();
  };
  function renderWeatherStations() {
    const root = el("weather-stations");
    const rfOnly = el<HTMLInputElement>("weather-rf-only").checked;
    const packets = [...weatherPackets.values()]
      .reverse()
      .filter((packet) => !rfOnly || packet.origin === "rf");
    root.replaceChildren();
    if (!packets.length) {
      root.textContent = rfOnly
        ? "No RF weather packets received yet."
        : "No weather packets received yet.";
      root.className = "message-note";
      return;
    }
    root.className = "";
    for (const packet of packets.slice(0, 200)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "station-list-item";
      const title = document.createElement("strong");
      title.textContent = packet.source;
      const detail = document.createElement("span");
      const temperature = packet.weather?.temperatureFahrenheit;
      detail.textContent = `${sourceLabel(packet.origin)} · ${new Date(packet.receivedAt).toLocaleString()} · ${temperature == null ? "Temperature unavailable" : `${temperature} °F`}`;
      button.append(title, detail);
      button.onclick = () => inspectPacket(packet);
      root.append(button);
    }
  }
  el<HTMLInputElement>("weather-rf-only").onchange = renderWeatherStations;
  function packetType(packet: DecodedPacket): string {
    if (packet.weather) return "weather";
    if (packet.message) return "message";
    if (packet.position) return "position";
    return "other";
  }
  function renderMonitor() {
    const packets = monitorSnapshot ?? monitorPackets;
    const search = el<HTMLInputElement>("monitor-search")
      .value.trim()
      .toUpperCase();
    const rf = el<HTMLInputElement>("monitor-rf-only").checked;
    const type = el<HTMLSelectElement>("monitor-type").value;
    const matches = packets.filter(
      (packet) =>
        (!rf || packet.origin === "rf") &&
        (type === "all" || packetType(packet) === type) &&
        (!search ||
          `${packet.source} ${packet.destination} ${packet.message?.addressee ?? ""} ${packet.raw}`
            .toUpperCase()
            .includes(search)),
    );
    el("monitor-status").textContent =
      `${monitorSnapshot ? `Paused · ${monitorWhilePaused} packets received since pause · ` : "Live · "}${matches.length} matching${matches.length > 200 ? " · showing 200 most recent" : ""}${!packets.length ? " · waiting for received packets" : ""}`;
    const rows = el("monitor-rows");
    rows.replaceChildren();
    for (const packet of matches.slice(0, 200)) {
      const row = document.createElement("tr");
      if (packet.origin === "rf") row.className = "monitor-rf";
      const summary =
        packet.message?.text ||
        (packet.position
          ? `${packet.position.latitude.toFixed(4)}°, ${packet.position.longitude.toFixed(4)}°`
          : packet.status || packet.raw);
      const values = [
        new Date(packet.receivedAt).toLocaleTimeString(),
        sourceLabel(packet.origin),
        packet.source || "—",
        packet.message?.addressee || packet.destination || "—",
        packet.kind.replaceAll("_", " "),
        summary,
      ];
      values.forEach((value, index) => {
        const cell = document.createElement("td");
        if (index === 2) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "monitor-open";
          button.textContent = value;
          button.setAttribute("aria-label", `Inspect packet from ${value}`);
          button.onclick = () => inspectPacket(packet);
          cell.append(button);
        } else cell.textContent = value;
        row.append(cell);
      });
      row.onclick = (event) => {
        if (!(event.target as HTMLElement).closest("button"))
          inspectPacket(packet);
      };
      rows.append(row);
    }
  }
  el("packets-button").onclick = () => {
    for (const id of ["stations-panel", "messages-panel", "weather-panel"])
      el(id).hidden = true;
    el("packets-panel").hidden = false;
    for (const id of [
      "stations-button",
      "messages-button",
      "weather-button",
      "map-button",
    ])
      el(id).classList.remove("active");
    el("packets-button").classList.add("active");
    renderMonitor();
    map.resize();
  };
  el<HTMLInputElement>("monitor-search").oninput = renderMonitor;
  el<HTMLInputElement>("monitor-rf-only").onchange = renderMonitor;
  el<HTMLSelectElement>("monitor-type").onchange = renderMonitor;
  el("monitor-pause").onclick = () => {
    if (monitorSnapshot) {
      monitorSnapshot = null;
      monitorWhilePaused = 0;
      el("monitor-pause").textContent = "Pause display";
    } else {
      monitorSnapshot = [...monitorPackets];
      el("monitor-pause").textContent = "Resume display";
    }
    renderMonitor();
  };
  let forecastGeneration = 0;
  async function refreshForecast() {
    const generation = ++forecastGeneration;
    const root = el("nws-forecast");
    if (!configuredLocation) {
      root.textContent =
        "Set a manual location using GPS to load a local forecast.";
      return;
    }
    const { lat, lon } = configuredLocation;
    root.textContent = "Loading NWS forecast…";
    try {
      const fetchJson = async (url: string) => {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(15000),
          headers: { Accept: "application/geo+json" },
        });
        if (!response.ok) throw new Error(`NWS returned ${response.status}`);
        return response.json();
      };
      const point = await fetchJson(
        `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      );
      const url = new URL(point.properties.forecast);
      if (
        url.origin !== "https://api.weather.gov" ||
        !url.pathname.startsWith("/gridpoints/")
      )
        throw new Error("Invalid NWS forecast address");
      const forecast = await fetchJson(url.href);
      if (generation !== forecastGeneration) return;
      const periods = forecast.properties?.periods;
      if (!Array.isArray(periods) || !periods.length)
        throw new Error("Forecast unavailable");
      root.replaceChildren();
      const updated = document.createElement("p");
      updated.className = "message-note";
      updated.textContent = `NWS forecast for ${lat.toFixed(4)}°, ${lon.toFixed(4)}° · Issued ${forecast.properties.updateTime ? new Date(forecast.properties.updateTime).toLocaleString() : "time unavailable"}`;
      root.append(updated);
      for (const period of periods.slice(0, 4)) {
        const item = document.createElement("div");
        item.className = "forecast-period";
        const title = document.createElement("strong");
        title.textContent = `${period.name ?? "Forecast"} · ${period.temperature ?? "—"} °${period.temperatureUnit ?? "F"}`;
        const detail = document.createElement("p");
        detail.textContent = `${period.shortForecast ?? ""} · Wind ${period.windSpeed ?? "—"} ${period.windDirection ?? ""}`;
        item.append(title, detail);
        root.append(item);
      }
    } catch (error) {
      if (generation === forecastGeneration)
        root.textContent = `NWS forecast unavailable: ${error instanceof Error ? error.message : String(error)}. Check your connection or location and try Refresh.`;
    }
  }
  el("weather-button").onclick = () => {
    el("stations-panel").hidden = true;
    el("messages-panel").hidden = true;
    el("weather-panel").hidden = false;
    el("packets-panel").hidden = true;
    el("packets-button").classList.remove("active");
    for (const id of ["stations-button", "messages-button", "map-button"])
      el(id).classList.remove("active");
    el("weather-button").classList.add("active");
    renderWeatherStations();
    map.resize();
    void refreshForecast();
  };
  el("refresh-weather").onclick = () => void refreshForecast();
  function showInbox(bbs: boolean) {
    el("aprs-inbox").hidden = bbs;
    el("bbs-inbox").hidden = !bbs;
    el("aprs-inbox-tab").setAttribute("aria-pressed", String(!bbs));
    el("bbs-inbox-tab").setAttribute("aria-pressed", String(bbs));
  }
  el("aprs-inbox-tab").onclick = () => showInbox(false);
  el("bbs-inbox-tab").onclick = () => showInbox(true);
  el("stations-button").onclick = () => showStations(true);
  el("map-button").onclick = () => showStations(false);
  el<HTMLInputElement>("station-search").oninput = renderStations;
  el<HTMLInputElement>("station-source").onchange = renderStations;
  for (const layer of ["station-dot", "station-icon"]) {
    map.on("click", layer, (e) => {
      const call = e.features?.[0]?.properties?.callsign;
      if (typeof call === "string") {
        selectStation(call);
      }
    });
    map.on(
      "mouseenter",
      layer,
      () => (map.getCanvas().style.cursor = "pointer"),
    );
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
  el("close-details").onclick = () => {
    selected = null;
    el("details").hidden = true;
    renderStations();
    map.resize();
  };
  el("show-packet").onclick = () => {
    const station = selected && stations.get(selected);
    if (station) inspectPacket(station.packet);
  };
  function renderPackets() {
    const filter = el<HTMLSelectElement>("packet-filter").value;
    const sent =
      filter !== "rf" && sentPacket && Date.now() < sentPacket.until
        ? sentPacket
        : null;
    const held =
      filter !== "is"
        ? heldRf
            .filter((item) => item.until > Date.now())
            .map((item) => item.packet)
        : [];
    const list = [...held, ...recent.filter((packet) => !held.includes(packet))]
      .filter(
        (p) =>
          filter === "all" ||
          (filter === "is" && p.origin === "aprs-is") ||
          (filter === "rf" && p.origin === "rf"),
      )
      .slice(0, sent ? 1 : 2);
    const root = el("packet-lines");
    root.replaceChildren();
    if (sent) {
      const line = document.createElement("div");
      line.className = "packet-sent";
      line.textContent = `SENT · APRS-IS  ${sent.raw}`;
      root.append(line);
    }
    if (!list.length && !sent) {
      const d = document.createElement("div");
      d.textContent =
        filter === "rf"
          ? "Waiting for RF packets · start the TNC receiver"
          : "Waiting for received packets";
      root.append(d);
      return;
    }
    for (const packet of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        packet.origin === "rf" ? "packet-line packet-rf" : "packet-line";
      button.title = "View packet details";
      button.setAttribute(
        "aria-label",
        `View packet from ${packet.source || "unknown station"}`,
      );
      const source = document.createElement("span");
      source.className = "packet-source";
      source.textContent = sourceLabel(packet.origin);
      button.append(source, document.createTextNode(packet.raw));
      button.onclick = () => inspectPacket(packet);
      root.append(button);
    }
  }
  el("packet-filter").onchange = renderPackets;
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-page]",
  ))
    button.onclick = () => {
      el("map-message").textContent =
        `${button.dataset.page} workspace is coming later.`;
      el("map-message").hidden = false;
      setTimeout(() => {
        el("map-message").hidden = true;
      }, 3000);
    };
  const bundledMap = (name: string) => {
    const key = `bundled-${name}`;
    const archive = new PMTiles({
      getKey: () => key,
      getBytes: async (offset: number, length: number) => ({
        data: new Uint8Array(await desktop.readMapRange(name, offset, length))
          .buffer,
      }),
    });
    protocol.add(archive);
    return `pmtiles://${key}`;
  };
  const worldUrl = bundledMap("world-z6.pmtiles");
  const demoUrl = bundledMap("michigan-lower-z12.pmtiles");
  map.once("load", () => {
    // Relative local URLs work with the packaged app and Vite; PMTiles reads byte ranges on demand.
    addBasemap(map, isDark(), "world", worldUrl, 0);
    addBasemap(map, isDark(), "regional", demoUrl, 7);
    addStationLayers();
    void loadSymbolSheets();
    el("map-message").hidden = true;
    el("map-state").textContent = "Offline map · world + Lower Michigan";
    applyTheme();
    updateMapColors(map, isDark());
  });
  let localPackId = 0;
  const mapSettingsDialog = el<HTMLDialogElement>("map-settings-dialog");
  el("settings-button").onclick = () => mapSettingsDialog.showModal();
  el("close-map-settings").onclick = () => mapSettingsDialog.close();
  el("restore-regional").onclick = () => {
    try {
      removeBasemap(map, "regional");
      addBasemap(map, isDark(), "regional", demoUrl, 7);
      el("regional-name").textContent = "Lower Michigan · zoom 12";
      el("map-state").textContent = "Offline map · world + Lower Michigan";
      el("map-settings-error").textContent = "";
    } catch (error) {
      el("map-settings-error").textContent =
        `Unable to restore the map: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  el<HTMLInputElement>("pack").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    el("map-settings-error").textContent = "";
    try {
      const key = `regional-${++localPackId}`;
      const source = new FileSource(file);
      source.getKey = () => key;
      const archive = new PMTiles(source);
      const header = await archive.getHeader();
      if (header.tileType !== 1)
        throw new Error("Choose a vector PMTiles file.");
      protocol.add(archive);
      removeBasemap(map, "regional");
      addBasemap(map, isDark(), "regional", `pmtiles://${key}`, 7);
      map.fitBounds(
        [
          [header.minLon, header.minLat],
          [header.maxLon, header.maxLat],
        ],
        { padding: 45, maxZoom: 12 },
      );
      el("regional-name").textContent =
        `${file.name} · zoom ${header.minZoom}–${header.maxZoom}`;
      el("map-state").textContent = `Offline map · ${file.name}`;
      el("map-message").hidden = true;
    } catch (error) {
      el("map-settings-error").textContent =
        `Unable to open map: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  const dialog = el<HTMLDialogElement>("connect-dialog");
  const connectForm = el<HTMLFormElement>("connect-form");
  const locationDialog = el<HTMLDialogElement>("location-dialog");
  const locationForm = el<HTMLFormElement>("location-form");
  const featureDialog = el<HTMLDialogElement>("feature-dialog");
  el("gps-button").onclick = () => locationDialog.showModal();
  el("close-location").onclick = () => locationDialog.close();
  el("close-feature").onclick = () => featureDialog.close();
  el("feature-done").onclick = () => featureDialog.close();
  function showFeature(title: string, description: string, status: string) {
    el("feature-kicker").textContent = "SETUP";
    el("feature-title").textContent = title;
    el("feature-description").textContent = description;
    el("feature-status").textContent = status;
    featureDialog.showModal();
  }
  const tncDialog = el<HTMLDialogElement>("tnc-dialog");
  let tncWanted = false;
  let tncGeneration = 0;
  let tncAttempt = 0;
  let tncStarting = false;
  const autoTnc = el<HTMLInputElement>("tnc-autoconnect");
  const storedAutoTnc = localStorage.getItem("openbeacon-tnc-autoconnect");
  autoTnc.checked =
    storedAutoTnc === null
      ? localStorage.getItem("openbeacon-tnc-audio") !== null ||
        localStorage.getItem("openbeacon-tnc-settings") !== null
      : storedAutoTnc === "true";
  autoTnc.onchange = () =>
    localStorage.setItem("openbeacon-tnc-autoconnect", String(autoTnc.checked));
  const tncAudio = el<HTMLInputElement>("tnc-audio");
  type TncSettings = {
    kind: "direwolf" | "serial" | "kenwood" | "tcp";
    device: string;
    port: string;
    baud: number;
    flow: string;
    endpoint: string;
    model: string;
  };
  let previousTnc = (() => {
    try {
      return JSON.parse(
        localStorage.getItem("openbeacon-tnc-settings") || "null",
      ) as TncSettings | null;
    } catch {
      return null;
    }
  })();
  const tncKind = el<HTMLSelectElement>("tnc-kind");
  const serialPort = el<HTMLSelectElement>("tnc-serial-port");
  const serialCustom = el<HTMLInputElement>("tnc-serial-custom");
  const baud = el<HTMLInputElement>("tnc-baud");
  const flow = el<HTMLSelectElement>("tnc-flow");
  const endpoint = el<HTMLInputElement>("tnc-endpoint");
  const model = el<HTMLSelectElement>("tnc-model");
  if (previousTnc) {
    if (["direwolf", "serial", "kenwood", "tcp"].includes(previousTnc.kind))
      tncKind.value = previousTnc.kind;
    baud.value = String(previousTnc.baud || 57600);
    flow.value = previousTnc.flow || "none";
    endpoint.value = previousTnc.endpoint || "127.0.0.1:8001";
    model.value = previousTnc.model || "generic";
  }
  function updateTncKind() {
    for (const [id, kind] of [
      ["tnc-audio-options", "direwolf"],
      [
        "tnc-serial-options",
        tncKind.value === "kenwood" ? "kenwood" : "serial",
      ],
      ["tnc-tcp-options", "tcp"],
    ])
      el(id).hidden = tncKind.value !== kind;
    el("tnc-serial-custom-label").hidden = serialPort.value !== "custom";
    tncAudio.required =
      tncKind.value === "direwolf" && tncDevice.value === "custom";
    serialCustom.required =
      ["serial", "kenwood"].includes(tncKind.value) &&
      serialPort.value === "custom";
    baud.required = ["serial", "kenwood"].includes(tncKind.value);
    endpoint.required = tncKind.value === "tcp";
    el("tnc-model-note").textContent =
      tncKind.value === "kenwood"
        ? "Native monitor mode reads TNC2-style text without setup commands. Enable monitoring on the TNC; output varies by settings. TS-2000 shares its COM port with CAT. Non-packet text is shown in Traffic Monitor."
        : model.value === "ts2000"
          ? "TS-2000: the rear COM port is shared with CAT. KISS mode requires an operator-led setup and power cycle; OpenBeacon will not change modes. Groundside observed 57600 baud with RTS/CTS on this setup; verify before connecting."
          : model.value === "d710"
            ? "TM-D710: enter KISS mode using the documented model-specific procedure. OpenBeacon will not send setup commands."
            : model.value === "d74"
              ? "TH-D74/D75: select KISS mode and USB or Bluetooth on the radio; legacy KISS ON / RESTART commands are not needed."
              : "Place the TNC in KISS mode before connecting. OpenBeacon sends no setup or mode commands.";
  }
  async function refreshSerialPorts(initial?: string) {
    const wanted =
      initial ??
      (serialPort.value === "custom" ? serialCustom.value : serialPort.value);
    try {
      const ports = await desktop.listSerialDevices();
      serialPort.replaceChildren();
      for (const port of ports) serialPort.add(new Option(port.name, port.id));
      serialPort.add(new Option("Other / enter manually", "custom"));
      if (
        wanted &&
        [...serialPort.options].some((option) => option.value === wanted)
      )
        serialPort.value = wanted;
      else if (wanted) {
        serialPort.value = "custom";
        serialCustom.value = wanted;
      }
      el("tnc-serial-status").textContent = ports.length
        ? `${ports.length} serial ports found. A listed port is not automatically identified as a TNC.`
        : "No serial ports found. You can enter a port manually.";
      updateTncKind();
    } catch (error) {
      el("tnc-serial-status").textContent =
        `Could not list serial ports: ${String(error)}`;
    }
  }
  tncKind.onchange = updateTncKind;
  serialPort.onchange = updateTncKind;
  model.onchange = () => {
    if (model.value === "ts2000") {
      baud.value = "57600";
      flow.value = "hardware";
    }
    updateTncKind();
  };
  el("tnc-refresh-serial").onclick = () => void refreshSerialPorts();

  const tncDevice = el<HTMLSelectElement>("tnc-device");
  let rememberedDevice =
    localStorage.getItem("openbeacon-tnc-audio") || "default";
  function updateDeviceChoice() {
    const custom = tncDevice.value === "custom";
    el("tnc-custom-label").hidden = !custom;
    tncAudio.required = custom && tncKind.value === "direwolf";
  }
  async function refreshAudioDevices(initial?: string) {
    const selected =
      tncDevice.value === "custom" ? tncAudio.value : tncDevice.value;
    const wanted = initial ?? selected;
    try {
      const devices = await desktop.listCaptureDevices();
      tncDevice.replaceChildren();
      const defaultOption = new Option("System default audio input", "default");
      tncDevice.add(defaultOption);
      for (const device of devices)
        tncDevice.add(new Option(device.name, device.id));
      tncDevice.add(new Option("Other / enter manually", "custom"));
      if ([...tncDevice.options].some((option) => option.value === wanted))
        tncDevice.value = wanted;
      else if (wanted && wanted !== "default") {
        tncDevice.value = "custom";
        tncAudio.value = wanted;
      }
      el("tnc-device-status").textContent = devices.length
        ? `${devices.length} hardware capture inputs found.`
        : "No hardware capture inputs found. You can still try the system default or enter a device manually.";
      updateDeviceChoice();
    } catch (error) {
      el("tnc-device-status").textContent =
        `Could not list audio inputs: ${String(error)}. You can enter one manually.`;
      if (wanted && wanted !== "default") {
        tncDevice.value = "custom";
        tncAudio.value = wanted;
      }
      updateDeviceChoice();
    }
  }
  tncDevice.onchange = updateDeviceChoice;
  el("refresh-tnc-devices").onclick = () => void refreshAudioDevices();
  el("tnc-button").onclick = () => {
    void refreshAudioDevices(rememberedDevice);
    void refreshSerialPorts(previousTnc?.port);
    updateTncKind();
    tncDialog.showModal();
  };
  el("close-tnc").onclick = () => tncDialog.close();
  async function startTnc(settings: TncSettings) {
    if (tncWanted || tncStarting) return;
    tncStarting = true;
    tncWanted = true;
    const attempt = ++tncAttempt;
    el<HTMLButtonElement>("tnc-connect").disabled = true;
    el("tnc-status").textContent = "Starting receiver…";
    try {
      await listenersReady;
      if (!tncWanted || attempt !== tncAttempt) return;
      if (settings.kind === "direwolf") {
        await desktop.startDirewolf(settings.device);
        if (!tncWanted || attempt !== tncAttempt) {
          await desktop.stopDirewolf();
          return;
        }
        rememberedDevice = settings.device;
        localStorage.setItem("openbeacon-tnc-audio", settings.device);
        tncGeneration = await desktop.connectTnc("127.0.0.1:8001", true);
      } else if (settings.kind === "serial" || settings.kind === "kenwood") {
        tncGeneration = await desktop.connectSerialTnc(
          settings.port,
          settings.baud,
          settings.flow,
          settings.kind === "kenwood" ? "kenwood" : "kiss",
        );
      } else {
        tncGeneration = await desktop.connectTnc(settings.endpoint, false);
      }
      previousTnc = settings;
      localStorage.setItem("openbeacon-tnc-settings", JSON.stringify(settings));
      localStorage.setItem(
        "openbeacon-tnc-autoconnect",
        String(autoTnc.checked),
      );
      if (!tncWanted || attempt !== tncAttempt) await desktop.disconnectTnc();
    } catch (error) {
      if (attempt !== tncAttempt) return;
      tncWanted = false;
      await desktop.stopDirewolf().catch(() => {});
      el("tnc-status").textContent = String(error);
      el("tnc-header-status").textContent = "Error";
    } finally {
      tncStarting = false;
      el<HTMLButtonElement>("tnc-connect").disabled = tncWanted;
    }
  }
  el<HTMLFormElement>("tnc-form").onsubmit = (event) => {
    event.preventDefault();
    const device =
      tncDevice.value === "custom" ? tncAudio.value.trim() : tncDevice.value;
    const port =
      serialPort.value === "custom"
        ? serialCustom.value.trim()
        : serialPort.value;
    void startTnc({
      kind: tncKind.value as TncSettings["kind"],
      device,
      port,
      baud: Number(baud.value),
      flow: flow.value,
      endpoint: endpoint.value.trim(),
      model: model.value,
    });
  };
  el("tnc-disconnect").onclick = async () => {
    tncWanted = false;
    tncAttempt++;
    await desktop.disconnectTnc();
    await desktop.stopDirewolf();
    el("tnc-status").textContent = "Disconnected";
    el("tnc-header-status").textContent = "Disconnected";
    el("tnc-dot").className = "";
    el<HTMLButtonElement>("tnc-connect").disabled = tncStarting;
  };
  const beaconDialog = el<HTMLDialogElement>("beacon-dialog");
  let beaconSending = false;
  let beaconScheduleActive = false;
  let beaconScheduleGeneration = 0;
  let beaconTimer: ReturnType<typeof setTimeout> | undefined;
  const intervalInput = el<HTMLInputElement>("beacon-interval");
  const savedInterval = Number(
    localStorage.getItem("openbeacon-beacon-interval"),
  );
  if (
    Number.isInteger(savedInterval) &&
    savedInterval >= 5 &&
    savedInterval <= 1440
  )
    intervalInput.value = String(savedInterval);
  function stopBeaconSchedule(reason = "Automatic beaconing stopped.") {
    beaconScheduleActive = false;
    beaconScheduleGeneration++;
    clearTimeout(beaconTimer);
    el("beacon-schedule-state").textContent = reason;
    el("tx-button").querySelector("small")!.textContent = "APRS-IS";
    updateBeaconMode();
  }
  async function scheduledBeacon(generation: number) {
    if (
      !beaconScheduleActive ||
      generation !== beaconScheduleGeneration ||
      !configuredLocation
    )
      return;
    beaconSending = true;
    updateBeaconMode();
    el("beacon-schedule-state").textContent = "Sending scheduled beacon…";
    try {
      const result = await desktop.sendPositionBeacon(
        savedCallsign,
        configuredLocation.lat,
        configuredLocation.lon,
        savedSymbol,
      );
      showSentPacket(result);
      if (generation !== beaconScheduleGeneration) return;
      const next = Date.now() + Number(intervalInput.value) * 60000;
      el("beacon-status").textContent = "Beacon sent to APRS-IS.";
      el("beacon-schedule-state").textContent =
        `Automatic beaconing active · next send ${new Date(next).toLocaleTimeString()}`;
      beaconTimer = setTimeout(
        () => void scheduledBeacon(generation),
        next - Date.now(),
      );
    } catch (error) {
      if (generation === beaconScheduleGeneration)
        stopBeaconSchedule(`Automatic beaconing stopped: ${String(error)}`);
    } finally {
      beaconSending = false;
      updateBeaconMode();
    }
  }
  el("beacon-start").onclick = async () => {
    if (
      beaconSending ||
      beaconScheduleActive ||
      !configuredLocation ||
      !savedCallsign ||
      el<HTMLSelectElement>("beacon-mode").value !== "fixed"
    )
      return;
    if (!intervalInput.reportValidity()) return;
    const generation = ++beaconScheduleGeneration;
    el("beacon-schedule-state").textContent = "Checking saved passcode…";
    try {
      const saved = await desktop.aprsPasscodeSaved(savedCallsign);
      if (generation !== beaconScheduleGeneration) return;
      if (!saved) {
        el("beacon-schedule-state").textContent =
          "Save an APRS-IS passcode in My Station first.";
        return;
      }
      localStorage.setItem("openbeacon-beacon-interval", intervalInput.value);
      beaconScheduleActive = true;
      el("tx-button").querySelector("small")!.textContent = "Auto · APRS-IS";
      updateBeaconMode();
      void scheduledBeacon(generation);
    } catch (error) {
      el("beacon-schedule-state").textContent = String(error);
    }
  };
  el("beacon-stop").onclick = () =>
    stopBeaconSchedule(
      beaconSending
        ? "Stopped; a send already in progress may still complete."
        : "Automatic beaconing stopped.",
    );
  el("tx-button").onclick = () => {
    el("beacon-status").textContent = "";
    el("beacon-preview").textContent =
      configuredLocation && savedCallsign
        ? `Station: ${savedCallsign} · Position: ${configuredLocation.lat.toFixed(5)}°, ${configuredLocation.lon.toFixed(5)}° · Symbol: ${savedSymbol}`
        : "Set your station callsign and manual location before sending.";
    updateBeaconMode();
    beaconDialog.showModal();
  };
  function updateBeaconMode() {
    const mobile = el<HTMLSelectElement>("beacon-mode").value === "mobile";
    el("fixed-beacon").hidden = mobile;
    el("mobile-beacon").hidden = !mobile;
    el<HTMLButtonElement>("send-beacon").disabled =
      beaconSending ||
      beaconScheduleActive ||
      mobile ||
      !configuredLocation ||
      !savedCallsign;
    el<HTMLButtonElement>("beacon-start").disabled =
      beaconSending ||
      beaconScheduleActive ||
      mobile ||
      !configuredLocation ||
      !savedCallsign;
    el<HTMLButtonElement>("beacon-stop").disabled = !beaconScheduleActive;
    intervalInput.disabled = beaconScheduleActive;
    el<HTMLSelectElement>("beacon-mode").disabled = beaconScheduleActive;
    el<HTMLSelectElement>("beacon-route").disabled = beaconScheduleActive;
  }
  el<HTMLSelectElement>("beacon-mode").onchange = updateBeaconMode;
  el("close-beacon").onclick = () => beaconDialog.close();
  el("passcode-link").onclick = async (event) => {
    event.preventDefault();
    try {
      await desktop.openPasscodeGenerator();
    } catch (error) {
      el("station-error").textContent =
        `Could not open browser: ${String(error)}. Open https://aprs.do3sww.de/ manually.`;
    }
  };
  el<HTMLFormElement>("beacon-form").onsubmit = async (event) => {
    event.preventDefault();
    if (
      beaconSending ||
      beaconScheduleActive ||
      el<HTMLSelectElement>("beacon-mode").value !== "fixed" ||
      !configuredLocation ||
      !savedCallsign
    )
      return;
    beaconSending = true;
    const button = el<HTMLButtonElement>("send-beacon");
    button.disabled = true;
    el("beacon-status").textContent = "Connecting and verifying login…";
    try {
      const packet = await desktop.sendPositionBeacon(
        savedCallsign,
        configuredLocation.lat,
        configuredLocation.lon,
        savedSymbol,
      );
      showSentPacket(packet);
      el("beacon-status").textContent = "Beacon sent to APRS-IS.";
    } catch (error) {
      el("beacon-status").textContent = String(error);
    } finally {
      beaconSending = false;
      updateBeaconMode();
    }
  };
  el("connection").onclick = () => dialog.showModal();
  el("close-dialog").onclick = () => dialog.close();
  const callsign = el<HTMLInputElement>("callsign");
  const ssid = el<HTMLSelectElement>("ssid");
  const ssidUses = [
    "Primary fixed station",
    "Additional station",
    "Additional station",
    "Additional station",
    "Additional station",
    "Other networks / phone",
    "Special activity / satellite",
    "Handheld / portable",
    "Boat / RV / second mobile",
    "Primary mobile",
    "Internet / iGate",
    "Balloon / aircraft",
    "One-way tracker / device",
    "Weather station",
    "Truck / full-time driver",
    "Additional station",
  ];
  for (let n = 0; n <= 15; n++) {
    const option = document.createElement("option");
    option.value = String(n);
    option.textContent = `${n === 0 ? "0 (no suffix)" : `-${n}`} — ${ssidUses[n]}`;
    ssid.append(option);
  }
  const settingsDialog = el<HTMLDialogElement>("settings-dialog"),
    stationForm = el<HTMLFormElement>("station-form");
  el("station-button").onclick = () => settingsDialog.showModal();
  el("close-settings").onclick = () => settingsDialog.close();
  let savedCallsign = localStorage.getItem("openbeacon-call") || "";
  let savedSymbol = "/-";
  let chosenSymbol = "/-";
  let chosenTable: 0 | 1 = 0;
  function setIdentityFields(full: string) {
    const match = /^([A-Z0-9]{3,6})(?:-(\d{1,2}))?$/i.exec(full);
    callsign.value = match?.[1] ?? full.split("-")[0] ?? "";
    const value = match?.[2] ?? "0";
    if (!Array.from(ssid.options).some((o) => o.value === value)) {
      const extra = document.createElement("option");
      extra.value = value;
      extra.textContent = `${value} (existing)`;
      ssid.append(extra);
    }
    ssid.value = value;
  }
  setIdentityFields(savedCallsign);
  function setSprite(element: HTMLElement, symbol: string) {
    const cells = symbolCells(symbol);
    if (!cells) {
      element.style.backgroundImage = "";
      return;
    }
    const url = new URL(
      `aprs-symbols/table-${cells.table}.png`,
      document.baseURI,
    ).href;
    element.style.backgroundImage = `url("${url}")`;
    element.style.backgroundSize = "384px 144px";
    element.style.backgroundPosition = `-${(cells.index % 16) * 24}px -${Math.floor(cells.index / 16) * 24}px`;
    element.style.backgroundRepeat = "no-repeat";
  }
  const iconNames: Record<string, string> = {
    "/-": "House",
    "/>": "Car",
    "/_": "Weather station",
    "/b": "Bicycle",
    "/j": "Jeep",
    "/k": "Truck",
    "/r": "Repeater",
    "/s": "Boat",
    "/y": "House with antenna",
    "/#": "Digipeater",
    "/[": "Jogger",
    "/v": "Van",
    "/a": "Ambulance",
    "/p": "Dog",
  };
  function renderSymbolGrid() {
    const grid = el("symbol-grid");
    grid.replaceChildren();
    const chosen = symbolCells(chosenSymbol);
    const table = chosenTable === 0 ? "/" : "\\";
    for (let index = 0; index < 94; index++) {
      const code = table + String.fromCharCode(index + 33),
        button = document.createElement("button");
      button.type = "button";
      button.className = "symbol-choice";
      const name =
        iconNames[code] ||
        `${chosenTable === 0 ? "Primary" : "Secondary"} ${code}`;
      button.title = name;
      button.setAttribute("aria-label", name);
      button.setAttribute(
        "aria-pressed",
        String(chosen?.table === chosenTable && chosen.index === index),
      );
      if (chosen?.table === chosenTable && chosen.index === index)
        button.classList.add("selected");
      const image = document.createElement("span");
      image.className = "symbol-sprite";
      setSprite(image, code);
      button.append(image);
      button.onclick = () => {
        chosenSymbol = code;
        renderSymbolGrid();
      };
      grid.append(button);
    }
    el("symbol-selection").textContent =
      `${iconNames[chosenSymbol] || "Symbol"} (${chosenSymbol})`;
    el("primary-table").classList.toggle("active", chosenTable === 0);
    el("secondary-table").classList.toggle("active", chosenTable === 1);
  }
  el("primary-table").onclick = () => {
    chosenTable = 0;
    renderSymbolGrid();
  };
  el("secondary-table").onclick = () => {
    chosenTable = 1;
    renderSymbolGrid();
  };
  el("station-button").onclick = () => {
    setIdentityFields(savedCallsign);
    el<HTMLInputElement>("station-passcode").value = "";
    void desktop.aprsPasscodeSaved(savedCallsign).then((saved) => {
      el("passcode-state").textContent = saved
        ? "Passcode saved for this callsign."
        : "No passcode saved for this callsign.";
    });
    chosenSymbol = savedSymbol;
    chosenTable = symbolCells(savedSymbol)?.table ?? 0;
    renderSymbolGrid();
    settingsDialog.showModal();
  };
  el("clear-passcode").onclick = async () => {
    try {
      if (beaconScheduleActive)
        stopBeaconSchedule(
          "Automatic beaconing stopped because the passcode was removed.",
        );
      await desktop.clearAprsPasscode();
      el("passcode-state").textContent = "Saved passcode removed.";
      el<HTMLInputElement>("station-passcode").value = "";
    } catch (error) {
      el("station-error").textContent = String(error);
    }
  };
  renderSymbolGrid();
  let configuredLocation = (() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("openbeacon-location") || "null",
      );
      return value &&
        Number.isFinite(value.lat) &&
        Number.isFinite(value.lon) &&
        Number.isFinite(value.radius) &&
        Math.abs(value.lat) <= 90 &&
        Math.abs(value.lon) <= 180 &&
        value.radius >= 1 &&
        value.radius <= 2000
        ? (value as { lat: number; lon: number; radius: number })
        : null;
    } catch {
      return null;
    }
  })();
  if (configuredLocation) {
    el<HTMLInputElement>("lat").value = String(configuredLocation.lat);
    el<HTMLInputElement>("lon").value = String(configuredLocation.lon);
    el<HTMLInputElement>("radius").value = String(configuredLocation.radius);
  }
  const locationControl = document.createElement("div");
  locationControl.className = "maplibregl-ctrl maplibregl-ctrl-group";
  const centerLocation = document.createElement("button");
  centerLocation.type = "button";
  centerLocation.className = "center-location";
  centerLocation.title = "Center on your location";
  centerLocation.setAttribute("aria-label", "Center on your location");
  centerLocation.textContent = "⊙";
  centerLocation.onclick = () => {
    if (configuredLocation) {
      map.flyTo({
        center: [configuredLocation.lon, configuredLocation.lat],
        essential: true,
      });
    } else {
      locationDialog.showModal();
    }
  };
  locationControl.append(centerLocation);
  map.addControl(
    { onAdd: () => locationControl, onRemove: () => locationControl.remove() },
    "top-right",
  );
  let locationMarker: maplibre.Marker | undefined;
  function showConfiguredLocation(lat: number, lon: number) {
    if (!locationMarker) {
      const marker = document.createElement("div");
      marker.className = "own-location";
      marker.setAttribute("role", "img");
      marker.setAttribute(
        "aria-label",
        "Your configured location, not a GPS fix",
      );
      const dot = document.createElement("span");
      dot.className = "own-location-dot";
      dot.setAttribute("aria-hidden", "true");
      marker.append(dot);
      setSprite(dot, savedSymbol);
      marker.title =
        "Your configured APRS-IS filter center; GPS is not connected";
      locationMarker = new maplibre.Marker({
        element: marker,
        anchor: "center",
      })
        .setLngLat([lon, lat])
        .addTo(map);
    } else locationMarker.setLngLat([lon, lat]);
  }
  if (configuredLocation)
    showConfiguredLocation(configuredLocation.lat, configuredLocation.lon);
  let wanted = false,
    generation = 0;
  function status(state: string, message: string) {
    el("connection-status").textContent = message;
    el("connection-dot").className =
      state === "connected"
        ? "green"
        : state === "connecting" || state === "reconnecting"
          ? "amber"
          : "";
  }
  function currentSettings(): ConnectionSettings {
    return {
      callsign: savedCallsign,
      lat: configuredLocation?.lat ?? 0,
      lon: configuredLocation?.lon ?? 0,
      radius: Number(el<HTMLInputElement>("radius").value),
      location_set: !!configuredLocation,
      symbol: savedSymbol,
      theme,
    };
  }
  function applySettings(settings: ConnectionSettings) {
    if (
      beaconScheduleActive &&
      (settings.callsign !== savedCallsign ||
        settings.symbol !== savedSymbol ||
        settings.location_set === false ||
        !configuredLocation ||
        settings.lat !== configuredLocation.lat ||
        settings.lon !== configuredLocation.lon)
    )
      stopBeaconSchedule(
        "Automatic beaconing stopped because station settings changed.",
      );
    theme =
      settings.theme === "light" || settings.theme === "dark"
        ? settings.theme
        : "system";
    el<HTMLSelectElement>("theme-choice").value = theme;
    applyTheme();
    savedCallsign = settings.callsign;
    if (!el("messages-panel").hidden) renderMessages();
    savedSymbol = settings.symbol || "/-";
    chosenSymbol = savedSymbol;
    chosenTable = symbolCells(chosenSymbol)?.table ?? 0;
    setIdentityFields(savedCallsign);
    renderSymbolGrid();
    el("connection-identity").textContent = savedCallsign
      ? `Station: ${savedCallsign} · change in My Station`
      : "Set your callsign in My Station.";
    const markerIcon = document.querySelector<HTMLElement>(".own-location-dot");
    if (markerIcon) setSprite(markerIcon, savedSymbol);
    el<HTMLInputElement>("lat").value =
      settings.location_set !== false ? String(settings.lat) : "";
    el<HTMLInputElement>("lon").value =
      settings.location_set !== false ? String(settings.lon) : "";
    el<HTMLInputElement>("radius").value = String(settings.radius);
    configuredLocation =
      settings.location_set !== false
        ? { lat: settings.lat, lon: settings.lon, radius: settings.radius }
        : null;
    if (!el("weather-panel").hidden) void refreshForecast();
    if (configuredLocation) {
      showConfiguredLocation(settings.lat, settings.lon);
      el("gps-status").textContent = "Manual location";
      el("gps-dot").className = "green";
      el("filter-location").textContent =
        `Filter center: ${settings.lat.toFixed(4)}°, ${settings.lon.toFixed(4)}° (manual)`;
    } else {
      locationMarker?.remove();
      locationMarker = undefined;
      localStorage.removeItem("openbeacon-location");
      el("gps-status").textContent = "Set location";
      el("gps-dot").className = "";
      el("filter-location").textContent =
        "Set your location using GPS in the status bar.";
    }
  }
  el<HTMLSelectElement>("theme-choice").onchange = async (event) => {
    const choice = (event.target as HTMLSelectElement).value as Theme;
    if (!["system", "light", "dark"].includes(choice)) return;
    el("map-settings-error").textContent = "";
    try {
      const existing = await desktop.loadSettings();
      await desktop.saveSettings({
        ...(existing ?? currentSettings()),
        theme: choice,
      });
      theme = choice;
      applyTheme();
    } catch (error) {
      el<HTMLSelectElement>("theme-choice").value = theme;
      el("map-settings-error").textContent =
        `Could not save theme: ${String(error)}`;
    }
  };
  async function saveSettings(): Promise<ConnectionSettings> {
    if (!connectForm.reportValidity())
      throw new Error("Check the settings and try again.");
    const settings = currentSettings();
    if (
      settings.callsign &&
      !/^[A-Z0-9]{3,6}(?:-[A-Z0-9]{1,2})?$/.test(settings.callsign)
    )
      throw new Error("Set a valid callsign and SSID in My Station.");
    await desktop.saveSettings(settings);
    localStorage.setItem("openbeacon-call", settings.callsign);
    if (settings.location_set)
      localStorage.setItem(
        "openbeacon-location",
        JSON.stringify({
          lat: settings.lat,
          lon: settings.lon,
          radius: settings.radius,
        }),
      );
    applySettings(settings);
    return settings;
  }
  async function connect(settings: ConnectionSettings, centerMap: boolean) {
    if (!settings.callsign)
      throw new Error(
        "Set your callsign and SSID in My Station before connecting.",
      );
    if (!settings.location_set)
      throw new Error("Set your location using GPS before connecting.");
    wanted = true;
    status("connecting", "Connecting…");
    try {
      const g = await desktop.connect(settings);
      generation = Math.max(generation, g);
      if (centerMap)
        map.flyTo({
          center: [settings.lon, settings.lat],
          zoom: Math.max(8, map.getZoom()),
          essential: true,
        });
    } catch (error) {
      wanted = false;
      status("disconnected", "Disconnected");
      throw error;
    }
  }
  function observePacket(packet: DecodedPacket, restoringHistory = false) {
    recent.unshift(packet);
    monitorPackets.unshift(packet);
    if (monitorSnapshot) monitorWhilePaused++;
    receivedMessages.observe(packet, savedCallsign);
    if (packet.weather && packet.source) {
      const key = `${packet.origin}:${packet.source.toUpperCase()}`;
      weatherPackets.delete(key);
      weatherPackets.set(key, packet);
      if (weatherPackets.size > 5000)
        weatherPackets.delete(weatherPackets.keys().next().value!);
    }
    if (packet.position && packet.source) {
      const evicted = stationStore.observe(packet);
      if (!restoringHistory || !mapCleared) mapStationStore.observe(packet);
      if (selected === evicted) {
        selected = null;
        el("details").hidden = true;
      }
      dirty = true;
    }
  }
  const listenersReady = Promise.all([
    desktop.onTncStatus((payload) => {
      if (!tncWanted || payload.generation < tncGeneration) return;
      tncGeneration = payload.generation;
      if (payload.state === "stopped") {
        tncWanted = false;
        el<HTMLButtonElement>("tnc-connect").disabled = false;
      }
      el("tnc-status").textContent = payload.message;
      el("tnc-counts").textContent =
        `${payload.received} packets · ${payload.errors} invalid or unsupported frames`;
      el("tnc-header-status").textContent =
        payload.state === "connected"
          ? "Connected"
          : payload.state === "error" || payload.state === "stopped"
            ? "Error"
            : "Connecting…";
      el("tnc-dot").className =
        payload.state === "connected"
          ? "green"
          : payload.state === "stopped"
            ? ""
            : "amber";
    }),
    desktop.onTncPackets((payload) => {
      if (!tncWanted || payload.generation !== tncGeneration) return;
      for (const packet of payload.packets) {
        observePacket(packet);
        highlightRfStation(packet);
        holdRf(packet);
      }
      recent = recent.slice(0, 100);
      monitorPackets = monitorPackets.slice(0, 2000);
      renderPackets();
      if (!el("packets-panel").hidden) renderMonitor();
      if (!el("messages-panel").hidden) renderMessages();
      if (!el("weather-panel").hidden) renderWeatherStations();
      el("station-count").textContent =
        `${stations.size.toLocaleString()} ${stations.size === 1 ? "station" : "stations"}`;
      updateDetails();
      renderStations();
    }),
    desktop.onHistoryError((message) => {
      el("history-status").textContent =
        `History could not be saved: ${message}`;
    }),
    desktop.onStatus((payload) => {
      if (!wanted || payload.generation < generation) return;
      generation = payload.generation;
      status(payload.state, payload.message);
    }),
    desktop.onPackets((payload) => {
      if (!wanted || payload.generation !== generation) return;
      for (const packet of payload.packets) {
        observePacket(packet);
      }
      recent = recent.slice(0, 100);
      monitorPackets = monitorPackets.slice(0, 2000);
      if (!el("packets-panel").hidden) renderMonitor();
      renderPackets();
      if (!el("messages-panel").hidden) renderMessages();
      if (!el("weather-panel").hidden) renderWeatherStations();
      el("station-count").textContent =
        `${stations.size.toLocaleString()} ${stations.size === 1 ? "station" : "stations"}`;
      updateDetails();
      renderStations();
    }),
  ]);
  async function startSavedConnection() {
    try {
      await listenersReady;
      let settings = await desktop.loadSettings();
      // Migrate settings saved by the earlier prototype, if any.
      if (!settings && savedCallsign && configuredLocation) {
        settings = {
          callsign: savedCallsign,
          ...configuredLocation,
          location_set: true,
          symbol: savedSymbol,
          theme,
        };
        await desktop.saveSettings(settings);
      }
      if (settings) applySettings(settings);
      try {
        const history = await desktop.loadHistory();
        for (const packet of history.reverse()) observePacket(packet, true);
        monitorPackets = monitorPackets.slice(0, 2000);
        recent = recent.slice(0, 100);
        dirty = true;
        renderPackets();
        el("station-count").textContent =
          `${stations.size.toLocaleString()} ${stations.size === 1 ? "station" : "stations"}`;
        el("history-status").textContent =
          `Local history · ${history.length.toLocaleString()} packets restored`;
      } catch (error) {
        el("history-status").textContent =
          `History unavailable: ${String(error)}`;
      }
      if (settings) {
        if (settings.callsign && settings.location_set !== false)
          await connect(settings, false);
      }
    } catch (error) {
      status("disconnected", "Settings unavailable");
      el("connect-error").textContent = String(error);
    }
  }
  void startSavedConnection().then(() => {
    if (
      autoTnc.checked &&
      (previousTnc || localStorage.getItem("openbeacon-tnc-audio"))
    )
      void startTnc(
        previousTnc ?? {
          kind: "direwolf",
          device: rememberedDevice,
          port: "",
          baud: 57600,
          flow: "none",
          endpoint: "127.0.0.1:8001",
          model: "generic",
        },
      );
  });
  stationForm.onsubmit = async (event) => {
    event.preventDefault();
    el("station-error").textContent = "";
    if (!stationForm.reportValidity()) return;
    const base = callsign.value.trim().toUpperCase(),
      selectedSsid = Number(ssid.value);
    if (
      !/^[A-Z0-9]{3,6}$/.test(base) ||
      !Number.isInteger(selectedSsid) ||
      selectedSsid < 0 ||
      selectedSsid > 15
    ) {
      el("station-error").textContent =
        "Enter a valid callsign and an SSID from 0 to 15.";
      return;
    }
    const full = selectedSsid ? `${base}-${selectedSsid}` : base;
    const settings = {
      ...currentSettings(),
      callsign: full,
      symbol: chosenSymbol,
    };
    try {
      const passcode = el<HTMLInputElement>("station-passcode").value;
      if (passcode) {
        if (beaconScheduleActive)
          stopBeaconSchedule(
            "Automatic beaconing stopped because the passcode changed.",
          );
        await desktop.saveAprsPasscode(full, passcode);
      }
      await desktop.saveSettings(settings);
      el<HTMLInputElement>("station-passcode").value = "";
      localStorage.setItem("openbeacon-call", full);
      applySettings(settings);
      settingsDialog.close();
    } catch (error) {
      el("station-error").textContent = String(error);
    }
  };
  locationForm.onsubmit = async (event) => {
    event.preventDefault();
    el("location-error").textContent = "";
    if (!locationForm.reportValidity()) return;
    const lat = Number(el<HTMLInputElement>("lat").value),
      lon = Number(el<HTMLInputElement>("lon").value);
    const radius = Number(el<HTMLInputElement>("radius").value);
    const settings: ConnectionSettings = {
      callsign: savedCallsign,
      lat,
      lon,
      radius:
        Number.isInteger(radius) && radius >= 1 && radius <= 2000
          ? radius
          : 100,
      location_set: true,
      symbol: savedSymbol,
      theme,
    };
    try {
      await desktop.saveSettings(settings);
      applySettings(settings);
      localStorage.setItem(
        "openbeacon-location",
        JSON.stringify({ lat, lon, radius: settings.radius }),
      );
      map.flyTo({
        center: [lon, lat],
        zoom: Math.max(8, map.getZoom()),
        essential: true,
      });
      locationDialog.close();
    } catch (error) {
      el("location-error").textContent = String(error);
    }
  };
  el("save-settings").onclick = async () => {
    el("connect-error").textContent = "";
    try {
      await saveSettings();
      dialog.close();
    } catch (error) {
      el("connect-error").textContent = String(error);
    }
  };
  connectForm.onsubmit = async (event) => {
    event.preventDefault();
    el("connect-error").textContent = "";
    try {
      const settings = await saveSettings();
      await listenersReady;
      await connect(settings, true);
      dialog.close();
    } catch (error) {
      el("connect-error").textContent = String(error);
    }
  };
  el("disconnect").onclick = async () => {
    wanted = false;
    try {
      await desktop.disconnect();
      status("disconnected", "Disconnected");
      dialog.close();
    } catch (error) {
      el("connect-error").textContent = String(error);
    }
  };
  applyTheme();
}

startApp();
