# OpenBeacon user guide

OpenBeacon displays APRS traffic from the internet and from supported radio interfaces. It can also send position, message and weather packets when you configure a connection. Features run while the application is open.

## Starting the app

Extract the release archive into a folder and keep its executable and helper programs together. On Linux run `./openbeacon` from that folder; on Windows open `OpenBeacon.exe`. The Windows build is experimental and requires Microsoft Edge WebView2. Linux needs the system WebKitGTK libraries; see the README for development prerequisites. You may need to give your user account access to serial or audio devices.

Map packs are not included. An internet connection is needed to download a map or use an online map. In **Settings → Configure maps**, choose an area and detail level, then download it. Higher zoom levels and larger areas need more storage and can take a long time. Only one downloaded region is retained. You can instead configure online maps using your own Protomaps API key, or open a compatible local PMTiles pack in Map setup. Windows map downloading is experimental and requires the included Windows map helper.

## Set up your station

1. Open **My Station** and enter your amateur callsign and SSID, then choose a symbol. An RF path and beacon comment are optional. Save your settings.
2. Open **GPS** and enter your station's latitude and longitude as decimal degrees. This manual location is used for fixed beaconing and the APRS-IS radius filter.
3. To receive online traffic, open **APRS-IS**, select a radius, and connect. The radius limits the APRS-IS server feed; it does not filter RF packets. Reconnect after changing your filter center.
4. To receive over the air, open **TNC**, select your interface and device, and connect. Configure your radio and TNC for the correct frequency and mode separately. Serial interfaces may require operating-system permissions. The bundled Dire Wolf audio receiver is Linux x86-64 only; serial and TCP KISS are available separately.

## Explore traffic

The map plots stations with valid positions. Select a station for its details, distance from your configured manual location, and packet inspection. The **Stations** panel searches callsigns and can show RF-only stations. The **Traffic Monitor** lets you filter by source or packet type, search, pause, and inspect packets; packets without a reported position have no packet distance. The recent-packet strip has its own source filter. The map's clear control removes displayed stations and tracks, not saved history.

## Send position beacons

In **Beacon → Beacon settings**, choose APRS-IS or a supported RF TNC. An APRS-IS passcode is required for APRS-IS transmission and is saved in My Station. Check the station identity, location, symbol, comment and RF path before sending. Use **Send once** or start the fixed-position schedule. The Beacon menu can start or stop an automatic schedule; its indicator is green when a schedule is active. Stopping a schedule cannot recall a packet already handed to a TNC.

For mobile SmartBeaconing, connect a GPS source in **GPS**, choose mobile mode in Beacon settings, review its speed, interval and turn settings, and start it. A fresh GPS fix with speed and course is required. The schedule stops if the fix becomes stale. Mobile operation and RF transmission need further real-hardware testing.

## Connect a GPS or phone

In **GPS**, select a serial port, NMEA TCP server, UDP listener, or gpsd service. Serial and network NMEA sources must provide valid checksummed RMC sentences. Bluetooth Classic SPP requires the operating system to pair the device and expose its service as a serial port; pairing alone may not do this. NavCast on Android can share the phone's internal GPS using Bluetooth SPP, TCP or UDP. Enable RMC output and enter the corresponding serial port or network address in OpenBeacon. The phone integration has not yet been verified with physical hardware. See the README for connection details and limitations.

## Messages

Open **Messages** to read APRS messages addressed to your configured station. Choose APRS-IS or a supported RF TNC, enter the recipient and message, and send. RF messages have their own path selection. The outbox shows acknowledgements where available and offers manual resend; automatic retries are not implemented. Automatic acknowledgements are optional and can transmit over RF. The BBS inbox is a placeholder.

## Weather

Open **Weather** for the local NWS forecast and received weather stations. The forecast and personal weather sections can be collapsed. A forecast uses your manual location and requires internet access within NWS coverage.

For your own station, configure a Weather Underground PWS station ID and API key or a supported Peet Bros serial device. Fetch and review the observation. Choose APRS-IS or RF and, for RF, select the weather path; this path and route are remembered. Send once, or configure the source and interval and start weather beaconing from Weather or the Beacon menu. Weather packets use your base callsign with SSID `-13`. Automatic weather beaconing runs only while the app is open, pauses on failed or stale observations, and retries at the next interval. Weather Underground credentials and serial hardware have not yet been verified with live devices in this project.

## Troubleshooting

- **No map:** Check your internet connection, map configuration and downloaded region. Online maps require a working API key. A freshly extracted release has no bundled map packs.
- **No APRS-IS stations:** Verify the callsign, manual location, radius and connection status. The radius applies only to the server feed.
- **No RF packets:** Check the radio frequency, audio or serial connection, TNC mode, baud rate and device permissions. Reception and transmit capabilities vary by interface.
- **GPS waiting:** Confirm the correct port or network endpoint, valid RMC output, and an actual satellite fix. GPSD and phone GPS support need hardware testing.
- **Beacon not sent:** Check the selected route, station settings, connection and status message. APRS-IS transmission needs a passcode; RF needs a connected transmitting TNC.

Refer to [README.md](README.md) for platform limitations, detailed source settings, privacy of stored credentials, and current hardware validation. Report issues with your OS, interface, steps and any error message; omit passcodes, API keys and private location data.
