import { addBasemap, removeBasemap, updateMapColors } from "./basemap";
import { appShell } from "./shell";
import * as maplibre from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { Protocol, PMTiles, FileSource } from "pmtiles";
import { desktop, type ConnectionSettings, type Theme } from "./desktop";
import { StationStore } from "./stations";
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
    new maplibre.NavigationControl({ showCompass: false }),
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
  const stations = stationStore.stations;
  let selected: string | null = null;
  let dirty = false;
  let recent: { source: string; line: string; decoded?: DecodedPacket }[] = [];
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
      features: [...stations.values()].map((s) => {
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
  function addStationLayers() {
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
  for (const layer of ["station-dot", "station-icon"]) {
    map.on("click", layer, (e) => {
      const call = e.features?.[0]?.properties?.callsign;
      if (typeof call === "string") {
        selected = call;
        el("details").hidden = false;
        updateDetails();
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
  };
  el("show-packet").onclick = () => {
    const s = selected && stations.get(selected);
    if (s) {
      recent.unshift({ source: sourceLabel(s.source), line: s.packet });
      renderPackets();
    }
  };
  function renderPackets() {
    const filter = el<HTMLSelectElement>("packet-filter").value;
    const list = recent
      .filter(
        (p) =>
          filter === "all" ||
          (filter === "is" && p.source === "APRS-IS") ||
          (filter === "rf" && p.source === "RF"),
      )
      .slice(0, 2);
    const root = el("packet-lines");
    root.replaceChildren();
    if (!list.length) {
      const d = document.createElement("div");
      d.textContent =
        filter === "rf"
          ? "Waiting for RF packets · TNC support coming later"
          : "Waiting for received packets";
      root.append(d);
      return;
    }
    for (const p of list) {
      const d = document.createElement("div");
      const source = document.createElement("span");
      source.className = "packet-source";
      source.textContent = p.source;
      d.append(source, document.createTextNode(p.line));
      root.append(d);
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
  el("tnc-button").onclick = () =>
    showFeature(
      "TNC setup",
      "Connect a radio TNC to receive and send packets. Dire Wolf and other compatible TNCs are planned.",
      "TNC connections are not implemented yet.",
    );
  el("tx-button").onclick = () =>
    showFeature(
      "Transmit setup",
      "Configure transmit routes and beaconing here once radio support is ready.",
      "Transmit is disabled and cannot be enabled in this version.",
    );
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
    chosenSymbol = savedSymbol;
    chosenTable = symbolCells(savedSymbol)?.table ?? 0;
    renderSymbolGrid();
    settingsDialog.showModal();
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
    theme =
      settings.theme === "light" || settings.theme === "dark"
        ? settings.theme
        : "system";
    el<HTMLSelectElement>("theme-choice").value = theme;
    applyTheme();
    savedCallsign = settings.callsign;
    savedSymbol = settings.symbol || "/-";
    chosenSymbol = savedSymbol;
    chosenTable = symbolCells(chosenSymbol)?.table ?? 0;
    setIdentityFields(savedCallsign);
    renderSymbolGrid();
    el("connection-identity").textContent = savedCallsign
      ? `Station: ${savedCallsign} · change in Station`
      : "Set your callsign in Station.";
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
      throw new Error("Set a valid callsign and SSID in Station.");
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
        "Set your callsign and SSID in Station before connecting.",
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
  const listenersReady = Promise.all([
    desktop.onStatus((payload) => {
      if (!wanted || payload.generation < generation) return;
      generation = payload.generation;
      status(payload.state, payload.message);
    }),
    desktop.onPackets((payload) => {
      if (!wanted || payload.generation !== generation) return;
      for (const packet of payload.packets) {
        recent.unshift({
          source: sourceLabel(packet.origin),
          line: packet.raw,
          decoded: packet,
        });
        if (packet.position && packet.source) {
          const evicted = stationStore.observe(packet);
          if (selected === evicted) {
            selected = null;
            el("details").hidden = true;
          }
          dirty = true;
        }
      }
      recent = recent.slice(0, 100);
      renderPackets();
      el("station-count").textContent =
        `${stations.size.toLocaleString()} ${stations.size === 1 ? "station" : "stations"}`;
      updateDetails();
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
      if (settings) {
        applySettings(settings);
        if (settings.callsign && settings.location_set !== false)
          await connect(settings, false);
      }
    } catch (error) {
      status("disconnected", "Settings unavailable");
      el("connect-error").textContent = String(error);
    }
  }
  void startSavedConnection();
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
      await desktop.saveSettings(settings);
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
