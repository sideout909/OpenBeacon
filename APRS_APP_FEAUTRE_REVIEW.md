# APRS application feature research

This is an early comparative research note, not a verified support matrix. Features and availability may differ between versions; see the README and roadmap for OpenBeacon’s current capabilities.

The APRS applications reviewed (**PinPoint APRS**, **YAAC**, **APRSISCE/32**, **Xastir**, and **UI-View32**) share a core set of standard functionalities essential to the APRS protocol and amateur radio packet operations.

Here is the breakdown of the features common across all five software clients:

### 1. APRS-IS Network Connectivity

* **iGate Support:** Every client can connect to the global APRS-IS (Internet Service) via TCP/IP to send local RF traffic to the internet or inject internet-based APRS packets onto the local RF network.
* **Server Auto-Routing:** They all support connection to APRS-IS tier-2 server hubs using standard passcode authentication.

### 2. Physical & Virtual TNC Interfacing

* **KISS Protocol Support:** All five applications natively support the standard **KISS** (Keep It Simple, Stupid) protocol over physical serial/USB ports, virtual COM ports, or TCP sockets.
* **Compatibility with Software TNCs:** Each application can interface with modern software packet engines such as **Direwolf** or **UZ7HO SoundModem** operating in KISS or AGWPE emulation mode.

### 3. Core APRS Protocol Operations

* **Position & Beaconing:** Ability to generate and broadcast station position beacons (fixed coordinates or dynamic GPS movement) with custom status text and standard APRS symbols (house, car, repeater, digipeater, etc.).
* **Two-Way Messaging & ACKs:** Built-in messaging interfaces capable of sending direct text messages to other APRS stations with automatic message acknowledgments (ACK/NAK processing).
* **Object & Item Management:** Capabilities to create, plot, and transmit custom APRS "Objects" or "Items" (e.g., event locations, weather hazards, repeater frequencies, hamfest locations) onto the map.

### 4. Station Tracking & Telemetry Decoding

* **Live Map Plotting:** Visual rendering of received station beacons, moving vehicles, weather stations, and static objects on a map view.
* **Raw Packet Monitoring:** Built-in terminal or raw packet monitoring windows that log raw AX.25 APRS frames for diagnostics and traffic inspection.
* **Weather Station (WX) Support:** Ability to receive, decode, parse, and display weather data (temperature, wind speed/direction, rain rate, pressure) transmitted by APRS weather nodes.

### 5. Configurable Path & Routing Controls

* **UNPROTO Path Customization:** All clients allow the operator to configure the outgoing AX.25 digipeater path (e.g., `WIDE1-1, WIDE2-1` for standard mobile/VHF operation or direct RF paths for local use).

------------------------------------------------------------------------------------------------------------------

The features provided by PC-based APRS applications are ranked below by operational value, categorized into tiers from most essential to niche.

---

## Tier 1: Mission-Critical / High Utility

*These features form the backbone of APRS and provide the greatest real-world utility during field operations, public service, and daily use.*

1. **Software TNC & Audio Modem Integration (Direwolf / UZ7HO / KISS over TCP)**
* **Why it's #1:** Hardware TNCs are increasingly legacy. Soundcard-based software modems like Direwolf decode weak or corrupted AX.25 packets far better than hardware. Native support for TCP-based KISS/AGW ports enables modern digital setups via simple USB sound cards (e.g., Digirig).


2. **Two-Way Direct Messaging & Gateway Routing**
* **Why:** Messaging elevates APRS from a simple tracking system into a resilient grid-down communication protocol. Compatibility with network gateways allows tactical stations to send SMS text messages (via SMSGTE/SMS servers) or emails directly to non-hams from the field.


3. **Offline Vector & Raster Tile Caching**
* **Why:** In emergency response (ARES/AUXCOMM) or off-grid operations, internet connections are rarely available. Applications that render cached OpenStreetMap vector tiles, Topo charts, or pre-loaded GIS shapefiles locally maintain situational awareness when networks fail.


4. **Bidirectional iGate Capability**
* **Why:** Bridges local VHF/UHF RF traffic to the global internet (APRS-IS) and vice-versa. An application that acts as an iGate serves as vital infrastructure for the entire local amateur radio community.



---

## Tier 2: Operational Enhancements

*These features significantly improve situational awareness and daily shack operations, though they are not strictly required for basic packet communication.*

5. **Multi-Port RF & TNC Routing Engine**
* **Why:** High-value for advanced stations running cross-band digipeating (e.g., listening on 144.390 MHz VHF and repeating out to 433.800 MHz UHF or HF).


6. **Live Overlay Data (Radar, Active Weather, Wildfire Polygons)**
* **Why:** Crucial for skywarn weather spotters and emergency managers. Layering real-time NEXRAD radar tiles, local weather station telemetry, or NWS warning polygons directly over radio-reported APRS positions instantly clarifies local environmental hazards.


7. **Custom Object & Waypoint Injection**
* **Why:** Allows an operator to drop interactive markers onto maps (such as command posts, water stations, or road hazards) and broadcast them over RF so every station on the frequency sees them.


8. **Configurable Digipeater Routing & Path Controls (UNPROTO)**
* **Why:** Prevents RF channel congestion. Fine-grained path routing (e.g., limiting hops to `WIDE1-1, WIDE2-1` or applying preemptive alias filters) keeps the local packet channel healthy.



---

## Tier 3: Specialized / Niche

*Useful for specific use cases, but unnecessary for the average operator.*

9. **TAK / ADS-B / AIS Protocol Integration**
* **Why:** High utility for tactical search-and-rescue teams (TAK) or maritime/aviation tracking, but adds unnecessary complexity for general APRS operations.


10. **Telemetry Logging & Sensor Charting**
* **Why:** Useful for tracking balloon launches, solar battery voltage, or remote repeater temperatures, but irrelevant for day-to-day messaging and tactical mapping.


11. **Auto-Answer / "Driving Mode" Messaging**
* **Why:** Convenient for mobile operations or unattended stations, but a secondary convenience feature compared to manual messaging.


12. **Raw Packet Inspection / Terminal Debuggers**
* **Why:** Vital for setup, troubleshooting, and verifying path headers, but offers little value during routine operations once the station is properly configured.