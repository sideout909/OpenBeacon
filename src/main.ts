import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { updateBlocked } from "./update-control";
import {
  connectionLocation,
  currentPosition,
  fixedPosition,
  freshPosition,
  type Position,
} from "./location";
import { migrateTncSelection, serialModels, type TncKind } from "./tnc-options";
import {
  smartBeaconDecision,
  type SmartBeaconSettings,
} from "./beacon-schedule";
import { feature as topoFeature } from "topojson-client";
import type { Topology } from "topojson-specification";
import countriesData from "./data/maps/countries.json";
import statesData from "./data/maps/us-states.json";
import {
  temperature as formatTemp,
  speedKnots,
  speedMph,
  pressure as formatPressure,
  kmToMiles,
  milesToKm,
  type Units,
} from "./units";
import { identifyDevice } from "./device-id";
import { addBasemap, removeBasemap, updateMapColors } from "./basemap";
import { appShell } from "./shell";
import * as maplibre from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { Protocol, PMTiles, FileSource } from "pmtiles";
import {
  desktop,
  type ConnectionSettings,
  type Theme,
  type WeatherObservation,
} from "./desktop";
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
  document.querySelectorAll<HTMLDialogElement>("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        dialog.close();
    });
  });
  let updateApplying = false;
  let messageTransmissions = 0;
  let units: Units =
    localStorage.getItem("openbeacon-units") === "metric"
      ? "metric"
      : "imperial";
  const unitsChoice = el<HTMLSelectElement>("units-choice");
  unitsChoice.value = units;
  const radiusInput = el<HTMLInputElement>("radius");
  function setRadius(km: number) {
    radiusInput.value = String(
      units === "metric" ? km : Number(kmToMiles(km).toFixed(1)),
    );
  }
  function radiusKm() {
    return Math.round(
      units === "metric"
        ? Number(radiusInput.value)
        : milesToKm(Number(radiusInput.value)),
    );
  }
  function updateRadiusUnits() {
    el("radius-label").textContent =
      `Radius (${units === "metric" ? "km" : "mi"})`;
    radiusInput.min = units === "metric" ? "1" : "0.7";
    radiusInput.max = units === "metric" ? "2000" : "1242.7";
    radiusInput.step = units === "metric" ? "1" : "0.1";
  }
  updateRadiusUnits();
  setRadius(100);
  unitsChoice.onchange = () => {
    const km = radiusKm();
    units = unitsChoice.value === "metric" ? "metric" : "imperial";
    localStorage.setItem("openbeacon-units", units);
    updateRadiusUnits();
    setRadius(km);
    updateDetails();
    if (!el("packets-panel").hidden) renderMonitor();
    if (!el("weather-panel").hidden) {
      renderWeatherStations();
      void refreshForecast();
    }
    if (packetDialog.open && inspectedPacket)
      showPacket(
        packetDialog,
        el("packet-detail-content"),
        inspectedPacket,
        units,
      );
  };
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
  let inspectedPacket: DecodedPacket | null = null;
  const inspectPacket = (packet: DecodedPacket) => {
    inspectedPacket = packet;
    showPacket(packetDialog, el("packet-detail-content"), packet, units);
  };
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
  function distanceAway(lat: number, lon: number): string {
    const location = currentPosition(freshGps(), configuredLocation);
    if (!location) return "—";
    const meters = new maplibre.LngLat(location.lon, location.lat).distanceTo(
      new maplibre.LngLat(lon, lat),
    );
    const km = meters / 1000;
    return `${(units === "metric" ? km : kmToMiles(km)).toFixed(1)} ${units === "metric" ? "km" : "mi"}`;
  }
  function updateDetails() {
    if (!selected) return;
    const s = stations.get(selected);
    if (!s) return;
    el("station-name").textContent = s.callsign;
    const icon = el("station-detail-icon");
    const cells = symbolCells(s.symbol);
    icon.replaceChildren();
    icon.setAttribute("aria-label", `Station symbol ${s.symbol}`);
    if (cells) {
      for (const [table, index] of [
        [cells.table, cells.index],
        ...(cells.overlay === undefined ? [] : [[2, cells.overlay]]),
      ]) {
        const sprite = document.createElement("span");
        sprite.className = "station-detail-sprite";
        sprite.style.backgroundImage = `url("${new URL(`aprs-symbols/table-${table}.png`, document.baseURI).href}")`;
        sprite.style.backgroundPosition = `-${(index % 16) * 48}px -${Math.floor(index / 16) * 48}px`;
        icon.append(sprite);
      }
    } else icon.textContent = "•";
    const fields: [string, string][] = [
      ["Source", sourceLabel(s.source)],
      [
        "Device / application",
        identifyDevice(s.packet.destination, s.packet.kind) ?? "Unknown",
      ],
      ["Last received", new Date(s.heardAt).toLocaleString()],
      ["Position", `${s.latitude.toFixed(4)}°, ${s.longitude.toFixed(4)}°`],
      ["Distance away", distanceAway(s.latitude, s.longitude)],
      ["Symbol", s.symbol],
      ["Position type", s.kind.replaceAll("_", " ")],
      [
        "Precision",
        s.ambiguity
          ? `Approximate · ${s.ambiguity} ambiguous digits`
          : "As reported",
      ],
      ["Speed", s.speedKnots == null ? "—" : speedKnots(s.speedKnots, units)],
      ["Course", s.courseDegrees == null ? "—" : `${s.courseDegrees}°`],
      ["Comment", s.comment || "—"],
      [
        "Temperature",
        s.weather?.temperatureFahrenheit == null
          ? "—"
          : formatTemp(s.weather.temperatureFahrenheit, units),
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
  type SentMessage = {
    from: string;
    to: string;
    text: string;
    id: string;
    route: string;
    path: string;
    at: number;
    state: "sending" | "pending" | "acknowledged" | "rejected" | "error";
    detail?: string;
  };
  let outbox: SentMessage[] = (() => {
    try {
      const items = JSON.parse(
        localStorage.getItem("openbeacon-outbox") || "[]",
      );
      return Array.isArray(items)
        ? items
            .slice(0, 200)
            .map((x: SentMessage) =>
              x.state === "sending" ? { ...x, state: "pending" } : x,
            )
        : [];
    } catch {
      return [];
    }
  })();
  const messageRoute = el<HTMLSelectElement>("message-route");
  const messagePath = el<HTMLSelectElement>("message-rf-path");
  messageRoute.onchange = () => {
    el("message-rf-options").hidden = messageRoute.value !== "rf";
  };
  function selectedMessagePath() {
    return messagePath.value === "station"
      ? savedRfPath
      : messagePath.value === "direct"
        ? ""
        : messagePath.value;
  }
  const autoAck = el<HTMLInputElement>("message-auto-ack");
  const lastAck = new Map<string, number>();
  autoAck.onchange = () => {
    if (!autoAck.checked) lastAck.clear();
  };
  type MessageAlert = {
    packet: DecodedPacket;
    key: string;
    state: "ready" | "sending" | "sent" | "error";
    error?: string;
  };
  const incomingDialog = el<HTMLDialogElement>("incoming-alert");
  const alerts: MessageAlert[] = [];
  function messageCanAck(packet: DecodedPacket) {
    return (
      !!packet.message?.id &&
      /^[A-Za-z0-9]{1,5}$/.test(packet.message.id) &&
      /^[A-Z0-9]{3,6}(?:-(?:[0-9]|1[0-5]))?$/.test(
        packet.source.toUpperCase(),
      ) &&
      (packet.origin === "rf" || packet.origin === "aprs-is")
    );
  }
  function renderIncomingAlert() {
    const alert = alerts[0];
    if (!alert) {
      if (incomingDialog.open) incomingDialog.close();
      return;
    }
    const packet = alert.packet,
      msg = packet.message!;
    el("incoming-alert-from").textContent =
      `From ${packet.source} to ${msg.addressee} · ${sourceLabel(packet.origin)}${msg.id ? ` · ID ${msg.id}` : ""}`;
    el("incoming-alert-message").textContent = msg.text;
    el("incoming-alert-count").textContent =
      alerts.length > 1 ? `${alerts.length} waiting` : "";
    el("incoming-alert-status").textContent =
      alert.state === "sent"
        ? "Acknowledgement written to the selected route."
        : alert.state === "sending"
          ? "Sending acknowledgement…"
          : alert.state === "error"
            ? `Acknowledgement failed: ${alert.error}`
            : messageCanAck(packet)
              ? `Send an acknowledgement via ${packet.origin === "rf" ? `RF (${savedRfPath || "direct"})` : "APRS-IS"} so the sender knows this message was received.`
              : "This message does not have a supported acknowledgement ID.";
    const button = el<HTMLButtonElement>("incoming-send-ack");
    button.hidden = !messageCanAck(packet);
    button.disabled = alert.state === "sending" || alert.state === "sent";
    button.textContent =
      alert.state === "error"
        ? "Retry acknowledgement"
        : "Send acknowledgement";
    if (!incomingDialog.open) incomingDialog.showModal();
  }
  function enqueueMessageAlert(packet: DecodedPacket): MessageAlert {
    const msg = packet.message!;
    const key = `${packet.source.toUpperCase()}:${msg.addressee.toUpperCase()}:${msg.id || packet.raw}:${msg.text}`;
    const existing = alerts.find((item) => item.key === key);
    if (existing) return existing;
    const alert: MessageAlert = { packet, key, state: "ready" };
    alerts.push(alert);
    if (alerts.length > 50) alerts.splice(1, 1);
    renderIncomingAlert();
    return alert;
  }
  async function acknowledgeMessage(packet: DecodedPacket) {
    if (updateApplying) throw new Error("An update is being installed.");
    if (!messageCanAck(packet) || !packet.message?.id)
      throw new Error("No valid acknowledgement ID or route.");
    if (packet.message.addressee.toUpperCase() !== savedCallsign.toUpperCase())
      throw new Error(
        "The station identity has changed; select the addressed callsign in My Station.",
      );
    messageTransmissions++;
    try {
      return await desktop.sendAprsMessage(
        savedCallsign,
        packet.source.toUpperCase(),
        "",
        packet.message.id,
        true,
        packet.origin === "rf" ? "rf" : "ip",
        savedRfPath,
      );
    } finally {
      messageTransmissions--;
    }
  }
  async function sendAlertAck(alert: MessageAlert) {
    if (alert.state === "sending" || alert.state === "sent") return;
    alert.state = "sending";
    renderIncomingAlert();
    try {
      const raw = await acknowledgeMessage(alert.packet);
      showSentPacket(raw);
      alert.state = "sent";
    } catch (error) {
      alert.state = "error";
      alert.error = String(error);
    }
    if (alerts.includes(alert)) renderIncomingAlert();
  }
  incomingDialog.addEventListener("close", () => {
    alerts.shift();
    if (alerts.length) renderIncomingAlert();
  });
  el("incoming-send-ack").onclick = () => {
    if (alerts[0]) void sendAlertAck(alerts[0]);
  };
  el("incoming-dismiss").onclick = () => incomingDialog.close();
  el("incoming-open").onclick = () => {
    incomingDialog.close();
    el("messages-button").click();
  };
  function saveOutbox() {
    localStorage.setItem(
      "openbeacon-outbox",
      JSON.stringify(outbox.slice(0, 200)),
    );
  }
  async function sendMessage(item: SentMessage) {
    if (updateApplying) {
      item.state = "error";
      item.detail = "An update is being installed.";
      saveOutbox();
      renderMessages();
      return;
    }
    item.state = "sending";
    item.detail = undefined;
    saveOutbox();
    renderMessages();
    try {
      const packet = await desktop.sendAprsMessage(
        item.from,
        item.to,
        item.text,
        item.id,
        false,
        item.route,
        item.path,
      );
      showSentPacket(packet);
      if (item.state === "sending") item.state = "pending";
    } catch (error) {
      if (item.state === "sending") {
        item.state = "error";
        item.detail = String(error);
      }
    }
    saveOutbox();
    renderMessages();
  }
  el("message-send").onclick = () => {
    const to = el<HTMLInputElement>("message-to").value.trim().toUpperCase();
    const text = el<HTMLTextAreaElement>("message-text").value;
    if (!savedCallsign) {
      el("message-send-status").textContent =
        "Set your callsign in My Station first.";
      return;
    }
    if (
      !/^[A-Z0-9]{3,6}(?:-(?:[0-9]|1[0-5]))?$/.test(to) ||
      !/^[\x20-\x7a\x7c-\x7e]{1,67}$/.test(text)
    ) {
      el("message-send-status").textContent =
        "Enter a valid callsign and 1–67 printable characters; { is reserved.";
      return;
    }
    const id = Math.floor(Math.random() * 60466176)
      .toString(36)
      .toUpperCase()
      .padStart(5, "0");
    const item: SentMessage = {
      from: savedCallsign,
      to,
      text,
      id,
      route: messageRoute.value,
      path: messageRoute.value === "rf" ? selectedMessagePath() : "",
      at: Date.now(),
      state: "pending",
    };
    outbox.unshift(item);
    outbox = outbox.slice(0, 200);
    el<HTMLTextAreaElement>("message-text").value = "";
    el("message-send-status").textContent = "Message added to the outbox.";
    void sendMessage(item);
  };
  function observeMessageTraffic(
    packet: DecodedPacket,
    restoring: boolean,
    newMessage: boolean,
  ) {
    const msg = packet.message;
    if (
      !msg ||
      msg.addressee.trim().toUpperCase() !== savedCallsign.toUpperCase()
    )
      return;
    if (msg.kind === "ack" || msg.kind === "reject") {
      const id =
        msg.text.match(/^(?:ack|rej)([A-Za-z0-9]{1,5})/i)?.[1] ?? msg.id;
      const item = outbox.find(
        (x) =>
          x.from === savedCallsign &&
          x.to === packet.source.toUpperCase() &&
          x.id === id &&
          (x.state === "pending" ||
            x.state === "sending" ||
            x.state === "error"),
      );
      if (item) {
        item.state = msg.kind === "ack" ? "acknowledged" : "rejected";
        saveOutbox();
      }
    } else if (!restoring && msg.kind === "message") {
      const alert = newMessage ? enqueueMessageAlert(packet) : undefined;
      if (autoAck.checked && messageCanAck(packet)) {
        const key = `${packet.source.toUpperCase()}:${msg.addressee.toUpperCase()}:${msg.id}:${msg.text}`;
        const now = Date.now();
        if (now - (lastAck.get(key) ?? 0) < 30000) return;
        lastAck.set(key, now);
        if (lastAck.size > 1000) lastAck.delete(lastAck.keys().next().value!);
        if (alert) void sendAlertAck(alert);
        else
          void acknowledgeMessage(packet)
            .then(showSentPacket)
            .catch((error) => {
              el("message-send-status").textContent =
                `Acknowledgement failed: ${String(error)}`;
            });
      }
    }
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
    const sent = el("message-outbox");
    sent.replaceChildren();
    for (const item of outbox.filter((x) => x.from === identity)) {
      const article = document.createElement("article");
      article.className = "message-item";
      const heading = document.createElement("strong");
      heading.textContent = `To ${item.to} · ${item.state}`;
      const meta = document.createElement("div");
      meta.className = "message-note";
      meta.textContent = `${item.route === "rf" ? `RF · ${item.path || "Direct"}` : "APRS-IS"} · ID ${item.id} · ${new Date(item.at).toLocaleString()}${item.detail ? ` · ${item.detail}` : ""}`;
      const body = document.createElement("p");
      body.textContent = item.text;
      article.append(heading, meta, body);
      if (item.state === "pending" || item.state === "error") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Resend";
        retry.onclick = () => void sendMessage(item);
        article.append(retry);
      }
      sent.append(article);
    }
    if (!sent.childElementCount) sent.textContent = "No sent messages yet.";
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
      if (messageCanAck(packet)) {
        const acknowledge = document.createElement("button");
        acknowledge.type = "button";
        acknowledge.textContent = "Send acknowledgement";
        acknowledge.onclick = async () => {
          acknowledge.disabled = true;
          try {
            showSentPacket(await acknowledgeMessage(packet));
            acknowledge.textContent = "Acknowledgement sent";
          } catch (error) {
            el("message-send-status").textContent =
              `Acknowledgement failed: ${String(error)}`;
            acknowledge.disabled = false;
          }
        };
        item.append(acknowledge);
      }
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
  el("message-station").onclick = () => {
    if (!selected) return;
    el<HTMLInputElement>("message-to").value = selected;
    el("messages-button").click();
    el<HTMLTextAreaElement>("message-text").focus();
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
      detail.textContent = `${sourceLabel(packet.origin)} · ${new Date(packet.receivedAt).toLocaleString()} · ${temperature == null ? "Temperature unavailable" : formatTemp(temperature, units)}`;
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
        packet.position
          ? distanceAway(packet.position.latitude, packet.position.longitude)
          : "—",
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
    const location = currentPosition(freshGps(), configuredLocation);
    if (!location) {
      root.textContent =
        "Set a manual location or connect GPS to load a local forecast.";
      return;
    }
    const { lat, lon } = location;
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
        const f =
          period.temperatureUnit === "C"
            ? (Number(period.temperature) * 9) / 5 + 32
            : Number(period.temperature);
        title.textContent = `${period.name ?? "Forecast"} · ${period.temperature == null || !Number.isFinite(f) ? "—" : formatTemp(f, units)}`;
        const detail = document.createElement("p");
        const wind = String(period.windSpeed ?? "—");
        const displayedWind =
          units === "metric" && /mph/i.test(wind)
            ? wind
                .replace(/(\d+(?:\.\d+)?)/g, (value: string) =>
                  String(Math.round(Number(value) * 1.609344)),
                )
                .replace(/mph/gi, "km/h")
            : wind;
        detail.textContent = `${period.shortForecast ?? ""} · Wind ${displayedWind} ${period.windDirection ?? ""}`;
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
  let weatherReady = false;
  let weatherBeaconActive = false;
  let weatherBeaconPaused = false;
  let weatherBeaconBusy = false;
  let weatherBeaconGeneration = 0;
  let weatherBeaconTimer: ReturnType<typeof setTimeout> | null = null;
  const weatherStatus = el("weather-source-status");
  const weatherSend = el<HTMLButtonElement>("weather-send");
  function weatherSourceBusy(busy: boolean) {
    for (const id of [
      "weather-wu-save",
      "weather-wu-clear",
      "weather-wu-refresh",
      "weather-peet-read",
    ])
      el<HTMLButtonElement>(id).disabled = busy || weatherBeaconActive;
    weatherSend.disabled = busy || weatherBeaconActive || !weatherReady;
    el<HTMLButtonElement>("weather-beacon-start").disabled =
      busy || weatherBeaconActive;
  }
  function resetWeather() {
    weatherReady = false;
    weatherSend.disabled = true;
    el("weather-observation").textContent = "";
    el("weather-send-status").textContent = "";
  }
  void desktop
    .weatherStationSaved()
    .then((station) => {
      if (station) {
        el<HTMLInputElement>("weather-wu-station").value = station;
        weatherStatus.textContent = `Saved source: ${station}. Select Get current weather to load an observation.`;
      }
    })
    .catch(() => {
      weatherStatus.textContent = "Could not read saved weather source.";
    });
  el("weather-wu-save").onclick = async () => {
    resetWeather();
    weatherSourceBusy(true);
    try {
      const station = el<HTMLInputElement>("weather-wu-station").value;
      const key = el<HTMLInputElement>("weather-wu-key").value;
      await desktop.saveWeatherCredentials(station, key);
      el<HTMLInputElement>("weather-wu-key").value = "";
      weatherStatus.textContent =
        "Source saved. Select Get current weather to check it.";
    } catch (error) {
      weatherStatus.textContent = String(error);
    } finally {
      weatherSourceBusy(false);
    }
  };
  el("weather-wu-clear").onclick = async () => {
    resetWeather();
    weatherSourceBusy(true);
    try {
      await desktop.clearWeatherCredentials();
      el<HTMLInputElement>("weather-wu-station").value = "";
      el<HTMLInputElement>("weather-wu-key").value = "";
      weatherStatus.textContent = "Weather Underground source removed.";
    } catch (error) {
      weatherStatus.textContent = String(error);
    } finally {
      weatherSourceBusy(false);
    }
  };
  function showWeatherObservation(obs: WeatherObservation) {
    weatherReady = true;
    weatherSend.disabled = weatherBeaconActive || weatherBeaconBusy;
    weatherStatus.textContent = `${obs.source} · observed ${new Date(obs.observedAt * 1000).toLocaleString()} · ${obs.lat.toFixed(4)}°, ${obs.lon.toFixed(4)}°${obs.sourceLastChangeAt == null ? "" : ` · last change detected ${new Date(obs.sourceLastChangeAt * 1000).toLocaleTimeString()}`}`;
    const value = (v: number | null, unit: string) =>
      v == null ? "unavailable" : `${Math.round(v * 10) / 10}${unit}`;
    el("weather-observation").textContent =
      `Temperature: ${obs.temperature == null ? "unavailable" : formatTemp(obs.temperature, units)} · Wind: ${obs.windSpeed == null ? "unavailable" : speedMph(obs.windSpeed, units)} from ${value(obs.windDirection, "°")} · Gust: ${obs.windGust == null ? "unavailable" : speedMph(obs.windGust, units)} · Humidity: ${value(obs.humidity, "%")} · Pressure: ${obs.pressureHpa == null ? "unavailable" : formatPressure(obs.pressureHpa * 10, units)}`;
  }
  el("weather-wu-refresh").onclick = async () => {
    resetWeather();
    weatherSourceBusy(true);
    weatherStatus.textContent = "Getting current weather…";
    try {
      const obs = await desktop.fetchWeather();
      showWeatherObservation(obs);
    } catch (error) {
      weatherStatus.textContent = String(error);
    } finally {
      weatherSourceBusy(false);
    }
  };
  const peetPorts = el<HTMLSelectElement>("weather-peet-port");
  peetPorts.onchange = () => {
    el("weather-peet-custom-label").hidden = peetPorts.value !== "custom";
  };
  el("weather-peet-refresh-ports").onclick = async () => {
    try {
      const devices = await desktop.listSerialDevices();
      peetPorts.replaceChildren(new Option("Enter port manually", "custom"));
      for (const device of devices)
        peetPorts.add(new Option(device.name, device.id));
      weatherStatus.textContent = devices.length
        ? "Select the weather station serial device."
        : "No serial devices found; enter a port manually.";
    } catch (error) {
      weatherStatus.textContent = String(error);
    }
  };
  el("weather-peet-read").onclick = async () => {
    resetWeather();
    weatherSourceBusy(true);
    weatherStatus.textContent =
      "Listening for Ultimeter data for up to 15 seconds…";
    try {
      const location = configuredLocation ?? freshGps();
      if (!location)
        throw new Error("Set a manual location or connect GPS first.");
      const port =
        peetPorts.value === "custom"
          ? el<HTMLInputElement>("weather-peet-custom").value.trim()
          : peetPorts.value;
      const obs = await desktop.readPeetWeather(
        port,
        location.lat,
        location.lon,
      );
      if (!configuredLocation && !freshGps())
        throw new Error("GPS fix became stale while reading weather.");
      showWeatherObservation(obs);
    } catch (error) {
      weatherStatus.textContent = String(error);
    } finally {
      weatherSourceBusy(false);
    }
  };
  const wxInterval = el<HTMLInputElement>("weather-beacon-interval");
  const wxSource = el<HTMLSelectElement>("weather-beacon-source");
  const wxRoute = el<HTMLSelectElement>("weather-tx-route");
  const wxPath = el<HTMLSelectElement>("weather-rf-path");
  const wxCustomPath = el<HTMLInputElement>("weather-custom-path");
  function setWeatherPath(path: string) {
    const preset = Array.from(wxPath.options).some(
      (option) => option.value === path && option.value !== "custom",
    );
    wxPath.value = preset ? path : "custom";
    wxCustomPath.value = preset ? "" : path;
    el("weather-custom-path-label").hidden = preset;
  }
  wxRoute.value =
    localStorage.getItem("openbeacon-weather-route") === "rf" ? "rf" : "ip";
  wxSource.value =
    localStorage.getItem("openbeacon-weather-source") === "peet"
      ? "peet"
      : "wu";
  const savedWxPath = localStorage.getItem("openbeacon-weather-rf-path");
  if (savedWxPath !== null) setWeatherPath(savedWxPath);
  function syncWeatherRoute() {
    el("weather-rf-path-label").hidden = wxRoute.value !== "rf";
    localStorage.setItem("openbeacon-weather-route", wxRoute.value);
  }
  wxRoute.onchange = syncWeatherRoute;
  wxSource.onchange = () =>
    localStorage.setItem("openbeacon-weather-source", wxSource.value);
  syncWeatherRoute();
  function weatherPath(): string | null {
    const path = (wxPath.value === "custom" ? wxCustomPath.value : wxPath.value)
      .trim()
      .toUpperCase();
    if (
      path &&
      (path.length > 71 ||
        path.split(",").length > 8 ||
        !path
          .split(",")
          .every((part) => /^[A-Z0-9]{1,6}(?:-(?:[0-9]|1[0-5]))?$/.test(part)))
    ) {
      el("weather-send-status").textContent =
        "Enter up to 8 valid comma-separated RF path aliases or callsigns.";
      wxScheduleStatus.textContent =
        "Enter up to 8 valid comma-separated RF path aliases or callsigns.";
      return null;
    }
    if (wxPath.value === "custom") wxCustomPath.value = path;
    localStorage.setItem("openbeacon-weather-rf-path", path);
    return path;
  }
  wxPath.onchange = () => {
    el("weather-custom-path-label").hidden = wxPath.value !== "custom";
    if (wxPath.value !== "custom") weatherPath();
  };
  wxCustomPath.onchange = () => {
    weatherPath();
  };
  const wxStart = el<HTMLButtonElement>("weather-beacon-start");
  const wxStop = el<HTMLButtonElement>("weather-beacon-stop");
  const wxScheduleStatus = el("weather-beacon-status");
  const storedWxInterval = Number(
    localStorage.getItem("openbeacon-weather-interval"),
  );
  if (
    Number.isInteger(storedWxInterval) &&
    storedWxInterval >= 5 &&
    storedWxInterval <= 1440
  )
    wxInterval.value = String(storedWxInterval);
  function syncWeatherBeaconControls() {
    updateBeaconIndicator();
    wxStart.disabled = weatherBeaconActive || weatherBeaconBusy;
    wxStop.disabled = !weatherBeaconActive;
    wxInterval.disabled = weatherBeaconActive;
    wxSource.disabled = weatherBeaconActive;
    wxRoute.disabled = weatherBeaconActive;
    wxPath.disabled = weatherBeaconActive;
    wxCustomPath.disabled = weatherBeaconActive;
    el("weather-beacon-quick").textContent = weatherBeaconActive
      ? "Stop weather beaconing"
      : "Start weather beaconing";
    weatherSourceBusy(weatherBeaconBusy);
  }
  function stopWeatherBeacon(message: string) {
    weatherBeaconActive = false;
    weatherBeaconPaused = false;
    weatherBeaconGeneration++;
    if (weatherBeaconTimer !== null) clearTimeout(weatherBeaconTimer);
    weatherBeaconTimer = null;
    wxScheduleStatus.textContent = message;
    syncWeatherBeaconControls();
  }
  wxStop.onclick = () =>
    stopWeatherBeacon(
      "Weather beacon stopped. A packet already handed to the TNC may still transmit.",
    );
  wxStart.onclick = () => {
    if (updateApplying) {
      wxScheduleStatus.textContent = "An update is being installed.";
      return;
    }
    if (weatherBeaconActive || weatherBeaconBusy) return;
    if (!wxInterval.value || !wxInterval.reportValidity()) return;
    if (!savedCallsign) {
      wxScheduleStatus.textContent = "Set your callsign in My Station first.";
      return;
    }
    const source = wxSource.value,
      route = wxRoute.value,
      call = savedCallsign,
      path = route === "rf" ? weatherPath() : "";
    if (path === null) return;
    const weatherPosition = fixedPosition(configuredLocation, freshGps());
    const location = weatherPosition?.position ?? null;
    const port =
      peetPorts.value === "custom"
        ? el<HTMLInputElement>("weather-peet-custom").value.trim()
        : peetPorts.value;
    if (source === "peet" && (!location || !port)) {
      wxScheduleStatus.textContent =
        "Set your station location and select a Peet Bros serial port first.";
      return;
    }
    const interval = Number(wxInterval.value) * 60000;
    localStorage.setItem("openbeacon-weather-interval", wxInterval.value);
    const generation = ++weatherBeaconGeneration;
    weatherBeaconActive = true;
    weatherBeaconPaused = false;
    syncWeatherBeaconControls();
    const run = async () => {
      if (!weatherBeaconActive || generation !== weatherBeaconGeneration)
        return;
      if (
        call !== savedCallsign ||
        (source === "peet" &&
          ((!weatherPosition?.requiresGps &&
            (!configuredLocation ||
              configuredLocation.lat !== location?.lat ||
              configuredLocation.lon !== location?.lon)) ||
            (weatherPosition?.requiresGps && !freshGps())))
      ) {
        stopWeatherBeacon(
          "Weather beacon stopped because the station location, GPS fix, or callsign changed. Start it again to use the current settings.",
        );
        return;
      }
      weatherBeaconBusy = true;
      syncWeatherBeaconControls();
      wxScheduleStatus.textContent = "Checking weather before transmission…";
      try {
        const obs =
          source === "wu"
            ? await desktop.fetchWeather()
            : await desktop.readPeetWeather(port, location!.lat, location!.lon);
        if (!weatherBeaconActive || generation !== weatherBeaconGeneration)
          return;
        if (source === "peet" && weatherPosition?.requiresGps && !freshGps())
          throw new Error("GPS fix became stale while reading weather.");
        showWeatherObservation(obs);
        const raw = await desktop.sendWeather(call, route, path);
        if (!weatherBeaconActive || generation !== weatherBeaconGeneration)
          return;
        showSentPacket(raw);
        weatherBeaconPaused = false;
        wxScheduleStatus.textContent = `Weather packet sent to the selected connection at ${new Date().toLocaleTimeString()}.`;
      } catch (error) {
        if (weatherBeaconActive && generation === weatherBeaconGeneration) {
          resetWeather();
          weatherBeaconPaused = true;
          wxScheduleStatus.textContent = `Weather beacon paused: ${String(error)} It will check again at the next interval.`;
        }
      } finally {
        weatherBeaconBusy = false;
        if (weatherBeaconActive && generation === weatherBeaconGeneration) {
          weatherBeaconTimer = setTimeout(() => void run(), interval);
        }
        syncWeatherBeaconControls();
      }
    };
    void run();
  };
  el("weather-send").onclick = async () => {
    if (updateApplying) {
      el("weather-send-status").textContent = "An update is being installed.";
      return;
    }
    if (!weatherReady) return;
    weatherBeaconBusy = true;
    syncWeatherBeaconControls();
    try {
      if (!savedCallsign)
        throw new Error("Set your callsign in My Station first.");
      const path = wxRoute.value === "rf" ? weatherPath() : "";
      if (path === null) return;
      const raw = await desktop.sendWeather(savedCallsign, wxRoute.value, path);
      showSentPacket(raw);
      el("weather-send-status").textContent =
        "Weather packet sent to the selected connection.";
    } catch (error) {
      el("weather-send-status").textContent = String(error);
    } finally {
      weatherBeaconBusy = false;
      syncWeatherBeaconControls();
    }
  };

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
  map.on("click", () => {
    if (
      [
        "stations-panel",
        "messages-panel",
        "weather-panel",
        "packets-panel",
      ].some((id) => !el(id).hidden)
    )
      showStations(false);
  });
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
  map.once("load", async () => {
    try {
      await protocol.get("bundled-world-z6.pmtiles")?.getHeader();
      addBasemap(map, isDark(), "world", worldUrl, 0);
    } catch {
      el("map-state").textContent = "World overview unavailable";
    }
    try {
      if (
        localStorage.getItem("openbeacon-map-mode") === "online" &&
        localStorage.getItem("openbeacon-map-api-key")
      )
        activateOnlineMap(localStorage.getItem("openbeacon-map-api-key")!);
      else if (localStorage.getItem("openbeacon-map-mode") === "downloaded")
        await activateDownloadedMap();
      else {
        await protocol.get("bundled-michigan-lower-z12.pmtiles")?.getHeader();
        addBasemap(map, isDark(), "regional", demoUrl, 7);
        el("map-state").textContent = "Offline map · world + Lower Michigan";
      }
    } catch {
      el("map-state").textContent =
        "Local regional map unavailable · configure maps";
    }
    addStationLayers();
    void loadSymbolSheets();
    el("map-message").hidden = true;
    applyTheme();
    updateMapColors(map, isDark());
  });
  let downloadedGeneration = 0;
  async function activateDownloadedMap() {
    const key = `downloaded-region-${++downloadedGeneration}`;
    const archive = new PMTiles({
      getKey: () => key,
      getBytes: async (offset: number, length: number) => ({
        data: new Uint8Array(await desktop.readDownloadedMap(offset, length))
          .buffer,
      }),
    });
    const header = await archive.getHeader();
    if (header.tileType !== 1)
      throw new Error("Downloaded map is not a vector PMTiles archive.");
    protocol.add(archive);
    removeBasemap(map, "regional");
    addBasemap(map, isDark(), "regional", `pmtiles://${key}`, 0);
    el("regional-name").textContent =
      `${localStorage.getItem("openbeacon-map-region") || "Downloaded region"} · zoom ${header.maxZoom}`;
    el("map-state").textContent =
      `Offline map · ${localStorage.getItem("openbeacon-map-region") || "downloaded region"}`;
    el("map-message").hidden = true;
    return header;
  }
  function activateOnlineMap(apiKey: string) {
    removeBasemap(map, "regional");
    addBasemap(
      map,
      isDark(),
      "regional",
      `https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${encodeURIComponent(apiKey)}`,
      0,
      true,
    );
    el("regional-name").textContent = "Protomaps online · zoom 12";
    el("map-state").textContent = "Online map · Protomaps";
    el("map-message").hidden = true;
  }
  const mapConfigDialog = el<HTMLDialogElement>("map-config-dialog");
  const regionChoice = el<HTMLSelectElement>("region-choice");
  type Region = {
    name: string;
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  };
  const countryFeatures = (
    countriesData as unknown as GeoJSON.FeatureCollection<
      GeoJSON.Polygon | GeoJSON.MultiPolygon
    >
  ).features;
  const statesTopology = statesData as unknown as Topology;
  const stateFeatures = (
    topoFeature(
      statesTopology,
      statesTopology.objects.states,
    ) as unknown as GeoJSON.FeatureCollection<
      GeoJSON.Polygon | GeoJSON.MultiPolygon
    >
  ).features;
  const usRegionStates: Record<string, string[]> = {
    Northeast: [
      "Connecticut",
      "Maine",
      "Massachusetts",
      "New Hampshire",
      "Rhode Island",
      "Vermont",
      "New Jersey",
      "New York",
      "Pennsylvania",
    ],
    Midwest: [
      "Illinois",
      "Indiana",
      "Michigan",
      "Ohio",
      "Wisconsin",
      "Iowa",
      "Kansas",
      "Minnesota",
      "Missouri",
      "Nebraska",
      "North Dakota",
      "South Dakota",
    ],
    South: [
      "Delaware",
      "District of Columbia",
      "Florida",
      "Georgia",
      "Maryland",
      "North Carolina",
      "South Carolina",
      "Virginia",
      "West Virginia",
      "Alabama",
      "Kentucky",
      "Mississippi",
      "Tennessee",
      "Arkansas",
      "Louisiana",
      "Oklahoma",
      "Texas",
    ],
    West: [
      "Arizona",
      "Colorado",
      "Idaho",
      "Montana",
      "Nevada",
      "New Mexico",
      "Utah",
      "Wyoming",
      "Alaska",
      "California",
      "Hawaii",
      "Oregon",
      "Washington",
    ],
  };
  const usRegions: Region[] = Object.entries(usRegionStates).map(
    ([name, states]) => ({
      name: `U.S. region · ${name}`,
      geometry: {
        type: "MultiPolygon",
        coordinates: stateFeatures
          .filter((f) => states.includes(String(f.properties?.name)))
          .flatMap((f) =>
            f.geometry.type === "Polygon"
              ? [f.geometry.coordinates]
              : f.geometry.coordinates,
          ),
      },
    }),
  );
  const conus: Region = {
    name: "Contiguous U.S.",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-125, 24],
          [-66, 24],
          [-66, 50],
          [-125, 50],
          [-125, 24],
        ],
      ],
    },
  };
  const regions: Region[] = [
    conus,
    ...usRegions,
    ...stateFeatures.map((f) => ({
      name: `U.S. · ${String(f.properties?.name)}`,
      geometry: f.geometry,
    })),
    ...countryFeatures.map((f) => ({
      name: String(f.properties?.name),
      geometry: f.geometry,
    })),
  ];
  for (const [index, region] of regions.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = region.name;
    regionChoice.append(option);
  }
  const regionLevel = el<HTMLSelectElement>("region-level");
  let regionMap: maplibre.Map | undefined;
  function updateRegionLevel() {
    if (regionMap?.getLayer("states-fill"))
      regionMap.setLayoutProperty(
        "states-fill",
        "visibility",
        regionLevel.value === "countries" ? "none" : "visible",
      );
  }
  regionLevel.onchange = updateRegionLevel;
  function updateRegionSelection() {
    const index = Number(regionChoice.value);
    const source = regionMap?.getSource("selected-region") as
      maplibre.GeoJSONSource | undefined;
    source?.setData({
      type: "Feature",
      properties: {},
      geometry: regions[index].geometry,
    });
  }
  function openMapConfigurator() {
    if (mapSettingsDialog.open) mapSettingsDialog.close();
    el<HTMLInputElement>("map-api-key").value =
      localStorage.getItem("openbeacon-map-api-key") || "";
    mapConfigDialog.showModal();
    if (regionMap) {
      regionMap.resize();
      return;
    }
    regionMap = new maplibre.Map({
      container: "region-map",
      center: [-96, 39],
      zoom: 2,
      attributionControl: false,
      style: {
        version: 8,
        sources: {},
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#b5d7df" },
          },
        ],
      },
    });
    regionMap.addControl(new maplibre.NavigationControl(), "top-right");
    regionMap.on("load", () => {
      regionMap!.addSource("countries", {
        type: "geojson",
        data: countriesData as unknown as GeoJSON.FeatureCollection,
      });
      regionMap!.addSource("states", {
        type: "geojson",
        data: { type: "FeatureCollection", features: stateFeatures },
      });
      regionMap!.addSource("selected-region", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: conus.geometry },
      });
      for (const id of ["countries", "states"]) {
        regionMap!.addLayer({
          id: `${id}-fill`,
          type: "fill",
          source: id,
          paint: {
            "fill-color": id === "states" ? "#dce9dc" : "#e4eadf",
            "fill-outline-color": "#7e9b8a",
          },
        });
      }
      regionMap!.addLayer({
        id: "selected-fill",
        type: "fill",
        source: "selected-region",
        paint: { "fill-color": "#229b75", "fill-opacity": 0.32 },
      });
      regionMap!.addLayer({
        id: "selected-outline",
        type: "line",
        source: "selected-region",
        paint: { "line-color": "#147454", "line-width": 2 },
      });
      for (const id of ["states", "countries"])
        regionMap!.on("click", `${id}-fill`, (event) => {
          if (
            id === "countries" &&
            regionMap!.queryRenderedFeatures(event.point, {
              layers: ["states-fill"],
            }).length
          )
            return;
          const name = event.features?.[0]?.properties?.name;
          const group =
            id === "states" && regionLevel.value === "regions"
              ? Object.keys(usRegionStates).find((key) =>
                  usRegionStates[key].includes(String(name)),
                )
              : undefined;
          const selectedName = group
            ? `U.S. region · ${group}`
            : id === "states"
              ? `U.S. · ${name}`
              : name;
          const index = regions.findIndex((r) => r.name === selectedName);
          if (index >= 0) {
            regionChoice.value = String(index);
            updateRegionSelection();
          }
        });
      updateRegionLevel();
      updateRegionSelection();
    });
  }
  regionChoice.onchange = updateRegionSelection;
  el("open-map-configurator").onclick = openMapConfigurator;
  el("close-map-config").onclick = () => mapConfigDialog.close();
  let activeMapDownload: string | null = null;
  let mapDownloadSequence = 0;
  const mapDownloadProgress = el<HTMLProgressElement>("map-download-progress");
  el("cancel-map-download").onclick = () => {
    activeMapDownload = null;
    mapDownloadProgress.removeAttribute("value");
    void desktop.cancelMapDownload();
    el("map-download-status").textContent = "Canceling download…";
  };
  void desktop.onMapDownloadProgress(({ requestId, percent }) => {
    if (
      requestId !== activeMapDownload ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 99
    )
      return;
    mapDownloadProgress.value = percent;
    el("map-download-status").textContent =
      `Downloading map tiles… ${percent}%`;
  });
  el("download-map").onclick = async () => {
    if (updateApplying) {
      el("map-download-status").textContent = "An update is being installed.";
      return;
    }
    const region = regions[Number(regionChoice.value)];
    if (!region) return;
    const download = el<HTMLButtonElement>("download-map"),
      cancel = el<HTMLButtonElement>("cancel-map-download");
    download.disabled = true;
    cancel.disabled = false;
    const requestId = String(++mapDownloadSequence);
    activeMapDownload = requestId;
    mapDownloadProgress.hidden = false;
    mapDownloadProgress.removeAttribute("value");
    el("map-download-status").textContent = `Preparing ${region.name}…`;
    try {
      await desktop.downloadRegionMap(
        region.geometry,
        Number(el<HTMLSelectElement>("map-detail").value),
        requestId,
      );
      activeMapDownload = null;
      mapDownloadProgress.removeAttribute("value");
      el("map-download-status").textContent =
        "Checking and opening the downloaded map…";
      localStorage.setItem("openbeacon-map-region", region.name);
      localStorage.setItem("openbeacon-map-mode", "downloaded");
      localStorage.setItem("openbeacon-map-setup", "done");
      const header = await activateDownloadedMap();
      map.fitBounds(
        [
          [header.minLon, header.minLat],
          [header.maxLon, header.maxLat],
        ],
        { padding: 45, maxZoom: 10 },
      );
      mapDownloadProgress.value = 100;
      el("map-download-status").textContent =
        `${region.name} downloaded and selected.`;
    } catch (error) {
      mapDownloadProgress.hidden = true;
      el("map-download-status").textContent = String(error);
    } finally {
      activeMapDownload = null;
      download.disabled = false;
      cancel.disabled = true;
    }
  };
  el("use-online-map").onclick = async () => {
    const key = el<HTMLInputElement>("map-api-key").value.trim();
    if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
      el("map-online-status").textContent = "Enter your Protomaps API key.";
      return;
    }
    const button = el<HTMLButtonElement>("use-online-map");
    button.disabled = true;
    el("map-online-status").textContent = "Checking the map service…";
    try {
      const response = await fetch(
        `https://api.protomaps.com/tiles/v4/0/0/0.mvt?key=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok)
        throw new Error(`Map service returned HTTP ${response.status}`);
      localStorage.setItem("openbeacon-map-api-key", key);
      localStorage.setItem("openbeacon-map-mode", "online");
      localStorage.setItem("openbeacon-map-setup", "done");
      activateOnlineMap(key);
      el("map-online-status").textContent = "Online map selected.";
    } catch (error) {
      el("map-online-status").textContent =
        `Could not use online maps: ${String(error)}. Check the key, connection, and provider CORS settings.`;
    } finally {
      button.disabled = false;
    }
  };
  el("map-provider-link").onclick = (event) => {
    event.preventDefault();
    void desktop.openMapProvider().catch((error) => {
      el("map-online-status").textContent = String(error);
    });
  };
  el("use-offline-map").onclick = async () => {
    try {
      await activateDownloadedMap();
      localStorage.setItem("openbeacon-map-mode", "downloaded");
    } catch {
      try {
        await protocol.get("bundled-michigan-lower-z12.pmtiles")!.getHeader();
        removeBasemap(map, "regional");
        addBasemap(map, isDark(), "regional", demoUrl, 7);
        localStorage.setItem("openbeacon-map-mode", "bundled");
        el("map-state").textContent = "Offline map · Lower Michigan";
      } catch {
        el("map-offline-status").textContent =
          "No saved offline map is available. Download a region first.";
        return;
      }
    }
    localStorage.setItem("openbeacon-map-setup", "done");
    el("map-offline-status").textContent = "Offline map selected.";
  };
  let localPackId = 0;
  const mapSettingsDialog = el<HTMLDialogElement>("map-settings-dialog");
  el("settings-button").onclick = () => mapSettingsDialog.showModal();
  el("close-map-settings").onclick = () => mapSettingsDialog.close();
  el<HTMLInputElement>("pack").addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    el("map-import-status").textContent = "";
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
      el("map-import-status").textContent = "Map opened for this session.";
      el("map-message").hidden = true;
    } catch (error) {
      el("map-import-status").textContent =
        `Unable to open map: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  const dialog = el<HTMLDialogElement>("connect-dialog");
  const connectForm = el<HTMLFormElement>("connect-form");
  const locationDialog = el<HTMLDialogElement>("location-dialog");
  const locationForm = el<HTMLFormElement>("location-form");
  const featureDialog = el<HTMLDialogElement>("feature-dialog");
  el("gps-button").onclick = () => {
    void refreshGpsPorts().catch((error) => {
      el("gps-detail").textContent = String(error);
    });
    locationDialog.showModal();
  };
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
    kind: TncKind;
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
  if (
    previousTnc &&
    ["direwolf", "serial", "kenwood", "tcp"].includes(previousTnc.kind)
  ) {
    const oldModel = previousTnc.model;
    const selection = migrateTncSelection(
      previousTnc.kind,
      previousTnc.model || "generic",
    );
    previousTnc = {
      ...previousTnc,
      kind: selection.kind,
      model: selection.model,
    };
    if (selection.needsReview) {
      autoTnc.checked = false;
      localStorage.setItem("openbeacon-tnc-autoconnect", "false");
      el("tnc-status").textContent =
        oldModel === "d74"
          ? "Autoconnect is off. TH-D74/D75 native APRS output is not verified in OpenBeacon; select a supported device and mode before reconnecting."
          : "Saved TNC selection needs review. Autoconnect is off; choose the correct connection and verify the device mode before reconnecting.";
    }
  }
  const tncKind = el<HTMLSelectElement>("tnc-kind");
  const serialPort = el<HTMLSelectElement>("tnc-serial-port");
  const serialCustom = el<HTMLInputElement>("tnc-serial-custom");
  const baud = el<HTMLSelectElement>("tnc-baud");
  const customBaud = el<HTMLInputElement>("tnc-custom-baud");
  function setBaud(value: number) {
    const option = String(value);
    baud.value = Array.from(baud.options).some((item) => item.value === option)
      ? option
      : "custom";
    customBaud.value = baud.value === "custom" ? option : "";
  }
  const flow = el<HTMLSelectElement>("tnc-flow");
  const endpoint = el<HTMLInputElement>("tnc-endpoint");
  const model = el<HTMLSelectElement>("tnc-model");
  if (previousTnc) {
    if (["direwolf", "serial", "kenwood", "tcp"].includes(previousTnc.kind))
      tncKind.value = previousTnc.kind;
    setBaud(previousTnc.baud || 57600);
    flow.value = previousTnc.flow || "none";
    endpoint.value = previousTnc.endpoint || "127.0.0.1:8001";
  }
  let displayedModelKind = "";
  function updateTncKind() {
    if (
      (tncKind.value === "serial" || tncKind.value === "kenwood") &&
      displayedModelKind !== tncKind.value
    ) {
      const kind = tncKind.value as "serial" | "kenwood";
      const initial =
        !displayedModelKind && previousTnc?.kind === kind
          ? previousTnc.model
          : "generic";
      model.replaceChildren(
        ...serialModels[kind].map(
          (option) => new Option(option.label, option.value),
        ),
      );
      model.value = initial || "generic";
      if (!model.value) model.value = "generic";
      displayedModelKind = kind;
    }
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
    el("tnc-custom-baud-label").hidden = baud.value !== "custom";
    customBaud.required = baud.required && baud.value === "custom";
    endpoint.required = tncKind.value === "tcp";
    el("tnc-model-note").textContent =
      tncKind.value === "kenwood"
        ? model.value === "ts2000"
          ? "TS-2000 native packet mode: enable Menu 55 and the internal TNC. The rear COM port is shared with CAT. This setup was tested at 57600 baud with hardware flow control; verify your radio settings."
          : model.value === "d710"
            ? "TM-D710 native APRS monitor text is receive-only and has not been verified with this model. Enable PC APRS output/monitoring on the radio; OpenBeacon does not configure radio modes."
            : "Receive-only TNC2-style monitor text. Enable compatible monitoring on the TNC; OpenBeacon does not configure its mode. Non-packet text appears in Traffic Monitor."
        : model.value === "nucleotnc"
          ? "NucleoTNC uses serial KISS at 38400 baud, 8N1, with no flow control. On Linux the ST-Link serial device is commonly /dev/ttyACM0."
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
  tncKind.onchange = () => {
    updateTncKind();
  };
  serialPort.onchange = updateTncKind;
  baud.onchange = updateTncKind;
  model.onchange = () => {
    if (model.value === "ts2000") {
      baud.value = "57600";
      flow.value = "hardware";
    } else if (model.value === "nucleotnc") {
      baud.value = "38400";
      flow.value = "none";
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
          settings.kind === "kenwood"
            ? settings.model === "ts2000"
              ? "ts2000"
              : "kenwood"
            : "kiss",
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
      baud: Number(baud.value === "custom" ? customBaud.value : baud.value),
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
  type GpsFix = {
    lat: number;
    lon: number;
    speedKnots: number | null;
    course: number | null;
    receivedAt: number;
  };
  let gpsFix: GpsFix | null = null;
  let gpsDisplayedFresh = false;
  let lastGpsDistanceUpdate = 0;
  let gpsWanted = false,
    gpsGeneration = 0;
  const gpsPort = el<HTMLSelectElement>("gps-port");
  const gpsCustom = el<HTMLInputElement>("gps-custom");
  const gpsBaud = el<HTMLSelectElement>("gps-baud");
  const gpsSource = el<HTMLSelectElement>("gps-source");
  const gpsEndpoint = el<HTMLInputElement>("gps-endpoint");
  gpsSource.onchange = () => {
    const source = gpsSource.value;
    el("gps-serial-options").hidden = source !== "serial";
    el("gps-network-options").hidden = source === "serial";
    gpsEndpoint.value =
      source === "gpsd"
        ? "127.0.0.1:2947"
        : source === "udp"
          ? "0.0.0.0:10110"
          : "";
    gpsEndpoint.placeholder =
      source === "tcp"
        ? "Phone or receiver IP:port"
        : source === "udp"
          ? "0.0.0.0:10110"
          : "127.0.0.1:2947";
    el("gps-network-hint").textContent =
      source === "udp"
        ? "Listen on this computer's address and port. Configure the phone to send to this computer's IP and port."
        : source === "tcp"
          ? "Enter the GPS server's IP address and port."
          : "Connect to a running gpsd service; receiver support depends on gpsd and the device.";
  };
  function freshGps(): GpsFix | null {
    return freshPosition(gpsFix);
  }
  async function refreshGpsPorts() {
    const devices = await desktop.listSerialDevices();
    const previous = gpsPort.value;
    gpsPort.replaceChildren();
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = device.name;
      gpsPort.append(option);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Enter port manually";
    gpsPort.append(custom);
    gpsPort.value = devices.some((d) => d.id === previous)
      ? previous
      : "custom";
    el("gps-custom-label").hidden = gpsPort.value !== "custom";
  }
  gpsPort.onchange = () => {
    el("gps-custom-label").hidden = gpsPort.value !== "custom";
  };
  el("gps-refresh").onclick = () =>
    void refreshGpsPorts().catch((error) => {
      el("gps-detail").textContent = String(error);
    });
  el("gps-connect").onclick = async () => {
    const source = gpsSource.value;
    const endpoint =
      source === "serial"
        ? gpsPort.value === "custom"
          ? gpsCustom.value.trim()
          : gpsPort.value
        : gpsEndpoint.value.trim();
    if (!endpoint) {
      el("gps-detail").textContent = "Choose a GPS port or enter an address.";
      return;
    }
    gpsWanted = true;
    gpsFix = null;
    try {
      gpsGeneration = await desktop.connectGps(
        source,
        endpoint,
        Number(gpsBaud.value),
      );
    } catch (error) {
      gpsWanted = false;
      el("gps-detail").textContent = String(error);
    }
  };
  el("gps-disconnect").onclick = async () => {
    gpsWanted = false;
    gpsFix = null;
    gpsDisplayedFresh = false;
    await desktop.disconnectGps();
    el("gps-detail").textContent = "GPS disconnected.";
    el("gps-status").textContent = configuredLocation
      ? "Manual location"
      : "Set location";
    el("gps-dot").className = configuredLocation ? "green" : "";
    if (configuredLocation)
      showConfiguredLocation(configuredLocation.lat, configuredLocation.lon);
    else {
      locationMarker?.remove();
      locationMarker = undefined;
    }
    updateDetails();
    if (!el("packets-panel").hidden) renderMonitor();
    if (!el("weather-panel").hidden) void refreshForecast();
    if (mobileActive || (beaconScheduleActive && fixedBeaconRequiresGps))
      stopBeaconSchedule("Beaconing stopped: GPS disconnected.");
  };
  const beaconDialog = el<HTMLDialogElement>("beacon-dialog");
  let beaconSending = false;
  let beaconScheduleActive = false;
  let mobileActive = false;
  let lastMobileTime = 0,
    lastMobileCourse = 0;
  let beaconScheduleGeneration = 0;
  let fixedBeaconPosition: Position | null = null;
  let fixedBeaconRequiresGps = false;
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
    mobileActive = false;
    fixedBeaconPosition = null;
    fixedBeaconRequiresGps = false;
    beaconScheduleGeneration++;
    clearTimeout(beaconTimer);
    el("beacon-schedule-state").textContent = reason;
    el("mobile-beacon-state").textContent = reason;
    updateBeaconMode();
  }
  async function sendConfiguredBeacon(
    fix?: Position & { speedKnots?: number | null; course?: number | null },
  ) {
    if (updateApplying) throw new Error("An update is being installed.");
    const location = fix ?? configuredLocation;
    if (!location) throw new Error("Set your station location first.");
    return el<HTMLSelectElement>("beacon-route").value === "rf"
      ? desktop.sendRfBeacon(
          savedCallsign,
          location.lat,
          location.lon,
          savedSymbol,
          savedComment,
          savedRfPath,
          fix?.speedKnots ?? null,
          fix?.course ?? null,
        )
      : desktop.sendPositionBeacon(
          savedCallsign,
          location.lat,
          location.lon,
          savedSymbol,
          savedComment,
          fix?.speedKnots ?? null,
          fix?.course ?? null,
        );
  }
  function beaconRouteLabel() {
    return el<HTMLSelectElement>("beacon-route").value === "rf"
      ? "RF TNC"
      : "APRS-IS";
  }
  async function scheduledBeacon(generation: number) {
    if (
      !beaconScheduleActive ||
      generation !== beaconScheduleGeneration ||
      !fixedBeaconPosition
    )
      return;
    beaconSending = true;
    updateBeaconMode();
    el("beacon-schedule-state").textContent = "Sending scheduled beacon…";
    try {
      if (fixedBeaconRequiresGps && !freshGps())
        throw new Error("GPS fix is missing or stale.");
      const result = await sendConfiguredBeacon(fixedBeaconPosition);
      showSentPacket(result);
      if (generation !== beaconScheduleGeneration) return;
      const next = Date.now() + Number(intervalInput.value) * 60000;
      el("beacon-status").textContent =
        `Beacon written to ${beaconRouteLabel()}.`;
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
  async function startAutoBeacon() {
    if (updateApplying) {
      el("beacon-schedule-state").textContent = "An update is being installed.";
      return;
    }
    if (
      beaconSending ||
      beaconScheduleActive ||
      !fixedPosition(configuredLocation, freshGps()) ||
      !savedCallsign ||
      el<HTMLSelectElement>("beacon-mode").value !== "fixed"
    )
      return;
    if (!intervalInput.reportValidity()) return;
    const generation = ++beaconScheduleGeneration;
    el("beacon-schedule-state").textContent = "Checking saved passcode…";
    try {
      const saved =
        el<HTMLSelectElement>("beacon-route").value === "rf" ||
        (await desktop.aprsPasscodeSaved(savedCallsign));
      if (generation !== beaconScheduleGeneration) return;
      if (!saved) {
        el("beacon-schedule-state").textContent =
          "Save an APRS-IS passcode in My Station first.";
        return;
      }
      const selectedPosition = fixedPosition(configuredLocation, freshGps());
      if (!selectedPosition) {
        el("beacon-schedule-state").textContent =
          "Set a manual location or connect GPS first.";
        return;
      }
      fixedBeaconPosition = selectedPosition.position;
      fixedBeaconRequiresGps = selectedPosition.requiresGps;
      localStorage.setItem("openbeacon-beacon-interval", intervalInput.value);
      beaconScheduleActive = true;
      updateBeaconMode();
      void scheduledBeacon(generation);
    } catch (error) {
      el("beacon-schedule-state").textContent = String(error);
    }
  }
  const smartIds = [
    "smart-slow-speed",
    "smart-fast-speed",
    "smart-slow-interval",
    "smart-fast-interval",
    "smart-turn-angle",
    "smart-turn-slope",
    "smart-turn-time",
  ];
  try {
    const saved = JSON.parse(
      localStorage.getItem("openbeacon-smart-settings") || "{}",
    );
    for (const id of smartIds)
      if (typeof saved[id] === "number" && Number.isFinite(saved[id]))
        el<HTMLInputElement>(id).value = String(saved[id]);
  } catch {
    /* use defaults */
  }
  function smartSettings(): SmartBeaconSettings | null {
    if (!smartIds.every((id) => el<HTMLInputElement>(id).reportValidity()))
      return null;
    const n = (id: string) => Number(el<HTMLInputElement>(id).value);
    const settings = {
      slowSpeed: n("smart-slow-speed"),
      fastSpeed: n("smart-fast-speed"),
      slowInterval: n("smart-slow-interval"),
      fastInterval: n("smart-fast-interval"),
      minTurnAngle: n("smart-turn-angle"),
      turnSlope: n("smart-turn-slope"),
      minTurnTime: n("smart-turn-time"),
    };
    return settings.fastSpeed > settings.slowSpeed &&
      settings.slowInterval >= settings.fastInterval
      ? settings
      : null;
  }
  async function sendMobileFix(generation: number, fix: GpsFix) {
    if (
      beaconSending ||
      !mobileActive ||
      generation !== beaconScheduleGeneration
    )
      return;
    beaconSending = true;
    updateBeaconMode();
    try {
      if (
        Date.now() - fix.receivedAt > 15000 ||
        !freshGps() ||
        fix.speedKnots == null ||
        fix.course == null
      )
        throw new Error("GPS fix is missing or stale.");
      const raw = await sendConfiguredBeacon(fix);
      showSentPacket(raw);
      if (generation !== beaconScheduleGeneration) return;
      lastMobileTime = performance.now();
      lastMobileCourse = fix.course;
      el("mobile-beacon-state").textContent =
        `SmartBeaconing active · last beacon ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (generation === beaconScheduleGeneration)
        stopBeaconSchedule(`SmartBeaconing stopped: ${String(error)}`);
    } finally {
      beaconSending = false;
      updateBeaconMode();
    }
  }
  el("mobile-start").onclick = async () => {
    if (updateApplying) {
      el("mobile-beacon-state").textContent = "An update is being installed.";
      return;
    }
    if (beaconSending || beaconScheduleActive || !savedCallsign) return;
    const fix = freshGps(),
      settings = smartSettings();
    if (!fix || fix.speedKnots == null || fix.course == null || !settings) {
      el("mobile-beacon-state").textContent =
        "A fresh GPS fix with speed and course and valid SmartBeaconing settings are required.";
      return;
    }
    const generation = ++beaconScheduleGeneration;
    try {
      if (
        beaconRouteLabel() === "APRS-IS" &&
        !(await desktop.aprsPasscodeSaved(savedCallsign))
      )
        throw new Error("Save an APRS-IS passcode in My Station first.");
      if (generation !== beaconScheduleGeneration || !freshGps()) return;
      localStorage.setItem(
        "openbeacon-smart-settings",
        JSON.stringify(
          Object.fromEntries(
            smartIds.map((id) => [id, Number(el<HTMLInputElement>(id).value)]),
          ),
        ),
      );
      beaconScheduleActive = true;
      mobileActive = true;
      lastMobileTime = 0;
      updateBeaconMode();
      void sendMobileFix(generation, fix);
    } catch (error) {
      el("mobile-beacon-state").textContent = String(error);
    }
  };
  el("mobile-stop").onclick = () =>
    stopBeaconSchedule(
      beaconSending
        ? "Stopped; a send already in progress may still complete."
        : "SmartBeaconing stopped.",
    );
  setInterval(() => {
    const fix = freshGps();
    if (gpsWanted && !fix) {
      el("gps-status").textContent = "Waiting for GPS";
      el("gps-dot").className = "amber";
      if (gpsDisplayedFresh) {
        gpsDisplayedFresh = false;
        if (configuredLocation)
          showConfiguredLocation(
            configuredLocation.lat,
            configuredLocation.lon,
          );
        else {
          locationMarker?.remove();
          locationMarker = undefined;
        }
        updateDetails();
        if (!el("packets-panel").hidden) renderMonitor();
        if (!el("weather-panel").hidden) void refreshForecast();
        if (beaconDialog.open) updateBeaconMode();
      }
    }
    if (beaconScheduleActive && fixedBeaconRequiresGps && !fix) {
      stopBeaconSchedule("Beaconing stopped: GPS fix is missing or stale.");
      return;
    }
    if (!mobileActive) return;
    if (!fix || fix.speedKnots == null || fix.course == null) {
      stopBeaconSchedule(
        "SmartBeaconing stopped: GPS fix is missing or stale.",
      );
      return;
    }
    const settings = smartSettings();
    if (
      settings &&
      lastMobileTime &&
      smartBeaconDecision(
        settings,
        fix.speedKnots * 1.150779448,
        fix.course,
        lastMobileCourse,
        (performance.now() - lastMobileTime) / 1000,
      )
    )
      void sendMobileFix(beaconScheduleGeneration, fix);
  }, 1000);
  el("beacon-start").onclick = () => void startAutoBeacon();
  el("beacon-stop").onclick = () =>
    stopBeaconSchedule(
      beaconSending
        ? "Stopped; a send already in progress may still complete."
        : "Automatic beaconing stopped.",
    );
  const beaconMenu = el("beacon-menu");
  function closeBeaconMenu() {
    beaconMenu.hidden = true;
    el("tx-button").setAttribute("aria-expanded", "false");
  }
  el("tx-button").onclick = () => {
    beaconMenu.hidden = !beaconMenu.hidden;
    el("tx-button").setAttribute("aria-expanded", String(!beaconMenu.hidden));
  };
  document.addEventListener("click", (event) => {
    if (
      !(event.target instanceof Node) ||
      !el("tx-button").parentElement?.contains(event.target)
    )
      closeBeaconMenu();
  });
  el("beacon-quick").onclick = async () => {
    closeBeaconMenu();
    if (beaconScheduleActive) {
      stopBeaconSchedule();
      return;
    }
    await startAutoBeacon();
    if (!beaconScheduleActive) openBeaconSettings();
  };
  el("weather-beacon-quick").onclick = () => {
    closeBeaconMenu();
    if (weatherBeaconActive) {
      wxStop.click();
      return;
    }
    wxStart.click();
    if (!weatherBeaconActive) {
      el<HTMLDetailsElement>("weather-station-details").open = true;
      el("weather-button").click();
    }
  };
  el("beacon-settings").onclick = () => {
    closeBeaconMenu();
    openBeaconSettings();
  };
  function openBeaconSettings() {
    el("beacon-status").textContent = "";
    const location = fixedPosition(configuredLocation, freshGps());
    el("beacon-preview").textContent =
      location && savedCallsign
        ? `Station: ${savedCallsign} · Position: ${location.position.lat.toFixed(5)}°, ${location.position.lon.toFixed(5)}° (${location.requiresGps ? "GPS fix" : "manual"}) · Symbol: ${savedSymbol}`
        : "Set your station callsign and a manual location or connect GPS before sending.";
    updateBeaconMode();
    beaconDialog.showModal();
  }
  function updateBeaconIndicator() {
    const statuses: string[] = [];
    if (beaconScheduleActive)
      statuses.push(
        `${mobileActive ? "Mobile" : "Auto"} · ${beaconRouteLabel()}`,
      );
    if (weatherBeaconActive)
      statuses.push(
        weatherBeaconPaused
          ? "Weather paused"
          : `Weather · ${wxRoute.value === "rf" ? "RF TNC" : "APRS-IS"}`,
      );
    el("tx-button").querySelector("small")!.textContent =
      statuses.join(" / ") || "Stopped";
    el("tx-button").querySelector("i")!.className =
      beaconScheduleActive || (weatherBeaconActive && !weatherBeaconPaused)
        ? "green"
        : "amber";
  }
  function updateBeaconMode() {
    updateBeaconIndicator();
    el("beacon-quick").textContent = beaconScheduleActive
      ? "Stop automatic beaconing"
      : "Start automatic beaconing";
    const mobile = el<HTMLSelectElement>("beacon-mode").value === "mobile";
    el("fixed-beacon").hidden = mobile;
    el("mobile-beacon").hidden = !mobile;
    el<HTMLButtonElement>("send-beacon").disabled =
      beaconSending ||
      beaconScheduleActive ||
      mobile ||
      !fixedPosition(configuredLocation, freshGps()) ||
      !savedCallsign;
    el<HTMLButtonElement>("beacon-start").disabled =
      beaconSending ||
      beaconScheduleActive ||
      mobile ||
      !fixedPosition(configuredLocation, freshGps()) ||
      !savedCallsign;
    el<HTMLButtonElement>("beacon-stop").disabled = !beaconScheduleActive;
    el<HTMLButtonElement>("mobile-start").disabled =
      beaconSending || beaconScheduleActive || !savedCallsign || !freshGps();
    el<HTMLButtonElement>("mobile-stop").disabled = !mobileActive;
    for (const id of smartIds)
      el<HTMLInputElement>(id).disabled = beaconScheduleActive;
    intervalInput.disabled = beaconScheduleActive;
    el<HTMLSelectElement>("beacon-mode").disabled = beaconScheduleActive;
    el<HTMLSelectElement>("beacon-route").disabled = beaconScheduleActive;
  }
  el<HTMLSelectElement>("beacon-mode").onchange = updateBeaconMode;
  const beaconRoute = el<HTMLSelectElement>("beacon-route");
  const storedRoute = localStorage.getItem("openbeacon-beacon-route");
  if (storedRoute === "rf" || storedRoute === "ip")
    beaconRoute.value = storedRoute;
  beaconRoute.onchange = () => {
    localStorage.setItem("openbeacon-beacon-route", beaconRoute.value);
    updateBeaconMode();
  };
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
      !fixedPosition(configuredLocation, freshGps()) ||
      !savedCallsign
    )
      return;
    const selectedPosition = fixedPosition(configuredLocation, freshGps());
    if (!selectedPosition) return;
    beaconSending = true;
    const button = el<HTMLButtonElement>("send-beacon");
    button.disabled = true;
    el("beacon-status").textContent = "Connecting and verifying login…";
    try {
      const packet = await sendConfiguredBeacon(selectedPosition.position);
      showSentPacket(packet);
      el("beacon-status").textContent =
        `Beacon written to ${beaconRouteLabel()}.`;
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
  let savedComment = "";
  let savedRfPath = "WIDE2-2";
  const pathSelect = el<HTMLSelectElement>("station-path");
  const customPath = el<HTMLInputElement>("station-custom-path");
  pathSelect.onchange = () => {
    el("station-custom-path-label").hidden = pathSelect.value !== "custom";
  };
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
    el<HTMLInputElement>("station-comment").value = savedComment;
    const preset = Array.from(pathSelect.options).some(
      (o) => o.value === savedRfPath && o.value !== "custom",
    );
    pathSelect.value = preset ? savedRfPath : "custom";
    customPath.value = preset ? "" : savedRfPath;
    el("station-custom-path-label").hidden = preset;
    el<HTMLInputElement>("station-passcode").value = "";
    void desktop.aprsPasscodeSaved(savedCallsign).then((saved) => {
      el("passcode-state").textContent = saved
        ? "Passcode saved for this callsign · APRS-IS beaconing enabled."
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
    setRadius(configuredLocation.radius);
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
    const location = currentPosition(freshGps(), configuredLocation);
    if (location) {
      map.flyTo({
        center: [location.lon, location.lat],
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
      marker.setAttribute("aria-label", "Your station location");
      const dot = document.createElement("span");
      dot.className = "own-location-dot";
      dot.setAttribute("aria-hidden", "true");
      marker.append(dot);
      setSprite(dot, savedSymbol);
      marker.title = "Your station location";
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
      radius: radiusKm(),
      location_set: !!configuredLocation,
      symbol: savedSymbol,
      theme,
      beacon_comment: savedComment,
      rf_path: savedRfPath,
    };
  }
  function applySettings(settings: ConnectionSettings) {
    if (
      beaconScheduleActive &&
      (settings.callsign !== savedCallsign ||
        settings.symbol !== savedSymbol ||
        (settings.beacon_comment ?? "") !== savedComment ||
        (settings.rf_path ?? "WIDE2-2") !== savedRfPath ||
        (settings.location_set !== false) !== !!configuredLocation ||
        (configuredLocation &&
          (settings.lat !== configuredLocation.lat ||
            settings.lon !== configuredLocation.lon)))
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
    savedComment = settings.beacon_comment ?? "";
    savedRfPath = settings.rf_path ?? "WIDE2-2";
    if (localStorage.getItem("openbeacon-weather-rf-path") === null)
      setWeatherPath(savedRfPath);
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
    setRadius(settings.radius);
    configuredLocation =
      settings.location_set !== false
        ? { lat: settings.lat, lon: settings.lon, radius: settings.radius }
        : null;
    updateDetails();
    if (!el("packets-panel").hidden) renderMonitor();
    if (!el("weather-panel").hidden) void refreshForecast();
    const fix = freshGps();
    const displayLocation = currentPosition(fix, configuredLocation);
    if (displayLocation) {
      showConfiguredLocation(displayLocation.lat, displayLocation.lon);
      el("gps-status").textContent = fix ? "GPS fix" : "Manual location";
      el("gps-dot").className = "green";
      el("filter-location").textContent =
        `Filter center will use ${fix ? "the current GPS fix" : "the manual location"} when connecting.`;
    } else {
      locationMarker?.remove();
      locationMarker = undefined;
      el("gps-status").textContent = gpsWanted
        ? "Waiting for GPS"
        : "Set location";
      el("gps-dot").className = gpsWanted ? "amber" : "";
      el("filter-location").textContent =
        "Set a manual location or connect GPS in the status bar.";
    }
    if (!configuredLocation) localStorage.removeItem("openbeacon-location");
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
    const connectionSettings = connectionLocation(
      settings,
      freshGps(),
      configuredLocation,
    );
    if (!connectionSettings)
      throw new Error(
        "Set a manual location or connect GPS and wait for a fix before connecting.",
      );
    const location = connectionSettings;
    wanted = true;
    status("connecting", "Connecting…");
    try {
      const g = await desktop.connect(connectionSettings);
      el("filter-location").textContent =
        `Filter center: ${location.lat.toFixed(4)}°, ${location.lon.toFixed(4)}° (${freshGps() ? "GPS at connection" : "manual"}); reconnect to update.`;
      generation = Math.max(generation, g);
      if (centerMap)
        map.flyTo({
          center: [location.lon, location.lat],
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
    const newMessage = receivedMessages.observe(packet, savedCallsign);
    observeMessageTraffic(packet, restoringHistory, newMessage);
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
    desktop.onGpsStatus((payload) => {
      if (!gpsWanted || payload.generation < gpsGeneration) return;
      gpsGeneration = payload.generation;
      el("gps-detail").textContent = payload.message;
      if (payload.state === "fix" && payload.fix) {
        const firstFix = !freshGps();
        gpsFix = payload.fix;
        gpsDisplayedFresh = true;
        el("gps-status").textContent = "GPS fix";
        el("gps-dot").className = "green";
        showConfiguredLocation(payload.fix.lat, payload.fix.lon);
        if (firstFix || Date.now() - lastGpsDistanceUpdate >= 5000) {
          lastGpsDistanceUpdate = Date.now();
          updateDetails();
          if (!el("packets-panel").hidden) renderMonitor();
        }
        if (firstFix && !el("weather-panel").hidden) void refreshForecast();
        if (beaconDialog.open) updateBeaconMode();
      } else if (payload.state === "error") {
        gpsWanted = false;
        gpsFix = null;
        gpsDisplayedFresh = false;
        if (configuredLocation)
          showConfiguredLocation(
            configuredLocation.lat,
            configuredLocation.lon,
          );
        else {
          locationMarker?.remove();
          locationMarker = undefined;
        }
        updateDetails();
        if (!el("packets-panel").hidden) renderMonitor();
        if (!el("weather-panel").hidden) void refreshForecast();
        el("gps-status").textContent = "GPS error";
        el("gps-dot").className = "amber";
        if (mobileActive || (beaconScheduleActive && fixedBeaconRequiresGps))
          stopBeaconSchedule("Beaconing stopped: GPS connection failed.");
      }
    }),
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
          beacon_comment: savedComment,
          rf_path: savedRfPath,
        };
        await desktop.saveSettings(settings);
      }
      if (settings) applySettings(settings);
      else if (!localStorage.getItem("openbeacon-map-setup"))
        openMapConfigurator();
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
    const comment = el<HTMLInputElement>("station-comment").value;
    const rfPath = (
      pathSelect.value === "custom" ? customPath.value : pathSelect.value
    )
      .trim()
      .toUpperCase();
    if (!/^[\x20-\x7e]{0,40}$/.test(comment)) {
      el("station-error").textContent =
        "Beacon comment must contain up to 40 printable English characters.";
      return;
    }
    if (
      rfPath &&
      (rfPath.split(",").length > 8 ||
        !rfPath
          .split(",")
          .every((part) => /^[A-Z0-9]{1,6}(?:-(?:[0-9]|1[0-5]))?$/.test(part)))
    ) {
      el("station-error").textContent =
        "Enter up to 8 comma-separated callsigns or aliases, each with an optional SSID from 0 to 15.";
      return;
    }
    const settings = {
      ...currentSettings(),
      callsign: full,
      symbol: chosenSymbol,
      beacon_comment: comment,
      rf_path: rfPath,
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
    const radius = radiusKm();
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
      beacon_comment: savedComment,
      rf_path: savedRfPath,
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
  let availableUpdate: Update | null = null;
  let updateBusy = false;
  let downloadedUpdate = false;
  let updateSupported = false;
  const updateStatus = el("update-status");
  const updateNotice = el<HTMLButtonElement>("update-notice");
  const updateCheck = el<HTMLButtonElement>("check-updates");
  const updateInstall = el<HTMLButtonElement>("install-update");
  const updateProgress = el<HTMLProgressElement>("update-progress");
  function updateIsBlocked() {
    return updateBlocked({
      positionBeacon: beaconScheduleActive,
      weatherBeacon: weatherBeaconActive,
      transmitting:
        beaconSending ||
        messageTransmissions > 0 ||
        outbox.some((item) => item.state === "sending"),
      weatherBusy: weatherBeaconBusy,
      mapDownload:
        activeMapDownload !== null ||
        !el<HTMLButtonElement>("cancel-map-download").disabled,
    });
  }
  async function checkForUpdates() {
    if (updateBusy) return;
    updateBusy = true;
    updateCheck.disabled = true;
    updateInstall.disabled = true;
    updateStatus.textContent = "Checking for updates…";
    try {
      updateSupported = await desktop.updateInstallSupported();
      const next = await checkUpdate({ timeout: 15000 });
      if (availableUpdate) await availableUpdate.close();
      availableUpdate = next;
      downloadedUpdate = false;
      updateProgress.hidden = true;
      updateNotice.hidden = !next;
      updateInstall.hidden = !next;
      if (!next) updateStatus.textContent = "OpenBeacon is up to date.";
      else {
        updateInstall.textContent = updateSupported
          ? "Download and install"
          : "Open release downloads";
        updateStatus.textContent = `Version ${next.version} is available.${updateSupported ? "" : " Install the AppImage to enable automatic updates."}`;
      }
    } catch (error) {
      updateStatus.textContent = `Could not check for updates: ${String(error)}`;
    } finally {
      updateBusy = false;
      updateCheck.disabled = false;
      updateInstall.disabled = false;
    }
  }
  updateCheck.onclick = () => void checkForUpdates();
  updateNotice.onclick = () => {
    if (!mapSettingsDialog.open) mapSettingsDialog.showModal();
  };
  updateInstall.onclick = async () => {
    if (updateBusy || !availableUpdate) return;
    if (!updateSupported) {
      try {
        await desktop.openReleases();
      } catch (error) {
        updateStatus.textContent = String(error);
      }
      return;
    }
    if (updateIsBlocked()) {
      updateStatus.textContent =
        "Stop beaconing and finish or cancel active transmissions and map downloads before updating.";
      return;
    }
    updateBusy = true;
    updateCheck.disabled = true;
    updateInstall.disabled = true;
    try {
      if (!downloadedUpdate) {
        updateProgress.hidden = false;
        updateProgress.removeAttribute("value");
        let downloaded = 0,
          total = 0;
        updateStatus.textContent = "Downloading update…";
        await availableUpdate.download(
          (event) => {
            if (event.event === "Started")
              total = event.data.contentLength ?? 0;
            if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              if (total > 0)
                updateProgress.value = Math.min(
                  100,
                  (downloaded / total) * 100,
                );
            }
            if (event.event === "Finished")
              updateStatus.textContent = "Verifying update…";
          },
          { timeout: 300000 },
        );
        downloadedUpdate = true;
      }
      if (updateIsBlocked()) {
        updateStatus.textContent =
          "Update downloaded. Stop beaconing and finish active operations, then select Install update.";
        updateInstall.textContent = "Install update";
        return;
      }
      updateApplying = true;
      updateStatus.textContent = "Installing update…";
      await availableUpdate.install();
      updateStatus.textContent = "Update installed. Restarting OpenBeacon…";
      await relaunch();
    } catch (error) {
      updateStatus.textContent = `Update failed: ${String(error)}`;
      updateProgress.hidden = true;
    } finally {
      updateApplying = false;
      updateBusy = false;
      updateCheck.disabled = false;
      updateInstall.disabled = false;
    }
  };
  // A check never starts a download or interrupts an active session.
  setTimeout(() => void checkForUpdates(), 5000);
  applyTheme();
}

startApp();
