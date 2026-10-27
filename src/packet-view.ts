import {
  temperature,
  speedMph,
  speedKnots,
  pressure,
  rainfall,
  type Units,
} from "./units";
import { identifyDevice } from "./device-id";
import { sourceLabel, type DecodedPacket } from "./aprs";

/** Render untrusted packet text as text, and freeze the selected observation in the dialog. */
export function showPacket(
  dialog: HTMLDialogElement,
  root: HTMLElement,
  packet: DecodedPacket,
  units: Units,
) {
  root.replaceChildren();
  const row = (label: string, value: string) => {
    const item = document.createElement("div");
    item.className = "detail-row";
    const name = document.createElement("span");
    const content = document.createElement("strong");
    name.textContent = label;
    content.textContent = value;
    item.append(name, content);
    root.append(item);
  };
  row("Source", sourceLabel(packet.origin));
  if (packet.sourceInterface) row("Interface", packet.sourceInterface);
  if (packet.kissPort != null) row("KISS port", String(packet.kissPort));
  row("Received", new Date(packet.receivedAt).toLocaleString());
  row("From", packet.source || "Unknown");
  row("Destination", packet.destination || "Unknown");
  row(
    "Device / application",
    identifyDevice(packet.destination, packet.kind) ?? "Unknown",
  );
  row("Path", packet.path.join(", ") || "None reported");
  row("Type", packet.kind.replaceAll("_", " "));
  if (packet.position) {
    const p = packet.position;
    row(
      "Position",
      `${p.latitude.toFixed(5)}°, ${p.longitude.toFixed(5)}°${p.ambiguity ? ` · approximate (${p.ambiguity} ambiguous digits)` : ""}`,
    );
    row("Symbol", p.symbol);
    if (p.timestamp) row("Packet time", p.timestamp);
    if (p.speedKnots !== null) row("Speed", speedKnots(p.speedKnots, units));
    if (p.courseDegrees !== null) row("Course", `${p.courseDegrees}°`);
    if (p.comment) row("Comment", p.comment);
  }
  if (packet.message) {
    row("Message to", packet.message.addressee);
    row("Message", packet.message.text || packet.message.kind);
    if (packet.message.id) row("Message ID", packet.message.id);
  }
  if (packet.status) row("Status", packet.status);
  if (packet.weather) {
    const w = packet.weather;
    const weather: [string, string | null][] = [
      [
        "Temperature",
        w.temperatureFahrenheit == null
          ? null
          : temperature(w.temperatureFahrenheit, units),
      ],
      [
        "Wind direction",
        w.windDirectionDegrees == null ? null : `${w.windDirectionDegrees}°`,
      ],
      [
        "Wind speed",
        w.windSpeedMph == null ? null : speedMph(w.windSpeedMph, units),
      ],
      [
        "Wind gust",
        w.windGustMph == null ? null : speedMph(w.windGustMph, units),
      ],
      ["Humidity", w.humidityPercent == null ? null : `${w.humidityPercent}%`],
      [
        "Pressure",
        w.pressureTenthsHpa == null
          ? null
          : pressure(w.pressureTenthsHpa, units),
      ],
      [
        "Rain (1h)",
        w.rainLastHourHundredthsInch == null
          ? null
          : rainfall(w.rainLastHourHundredthsInch, units),
      ],
      [
        "Rain (24h)",
        w.rainLast24HoursHundredthsInch == null
          ? null
          : rainfall(w.rainLast24HoursHundredthsInch, units),
      ],
      [
        "Rain (midnight)",
        w.rainSinceMidnightHundredthsInch == null
          ? null
          : rainfall(w.rainSinceMidnightHundredthsInch, units),
      ],
    ];
    for (const [label, value] of weather) if (value != null) row(label, value);
  }
  if (packet.warnings.length) row("Warnings", packet.warnings.join("; "));
  const rawTitle = document.createElement("h3");
  rawTitle.textContent = "Raw packet";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "secondary";
  copy.textContent = "Copy raw packet";
  const feedback = document.createElement("span");
  feedback.className = "copy-feedback";
  feedback.setAttribute("role", "status");
  copy.onclick = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(packet.raw);
      } else {
        const selection = document.createElement("textarea");
        selection.value = packet.raw;
        selection.style.position = "fixed";
        selection.style.opacity = "0";
        dialog.append(selection);
        selection.select();
        const copied = document.execCommand("copy");
        selection.remove();
        if (!copied) throw new Error("Copy unavailable");
      }
      feedback.textContent = "Copied";
    } catch {
      feedback.textContent = "Copy failed — select the raw packet to copy it.";
    }
  };
  const actions = document.createElement("div");
  actions.className = "copy-actions";
  actions.append(copy, feedback);
  const raw = document.createElement("pre");
  raw.className = "packet-raw";
  raw.textContent = packet.raw;
  const bytesTitle = document.createElement("h3");
  bytesTitle.textContent = "Original bytes (hex)";
  const bytes = document.createElement("pre");
  bytes.className = "packet-raw";
  bytes.textContent = packet.rawBytes
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  root.append(rawTitle, raw, actions, bytesTitle, bytes);
  if (packet.ax25Bytes) {
    const title = document.createElement("h3");
    title.textContent = "Original AX.25 frame (hex)";
    const frame = document.createElement("pre");
    frame.className = "packet-raw";
    frame.textContent = packet.ax25Bytes
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    root.append(title, frame);
  }
  if (!dialog.open) dialog.showModal();
}
