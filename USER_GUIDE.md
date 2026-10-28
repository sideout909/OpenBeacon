# OpenBeacon user guide

OpenBeacon displays APRS traffic from the internet and from supported radio interfaces. It can also send position, message and weather packets when you configure a connection. Features run while the application is open.

## Starting the app

On Windows, run the OpenBeacon setup installer and follow its prompts. On Linux, mark the OpenBeacon AppImage executable and open it. Portable archives, when provided, must be extracted with their helper programs kept alongside the executable. Windows requires Microsoft Edge WebView2 and the installer may need an internet connection to install it. Linux needs the system WebKitGTK libraries; see the README for development prerequisites. You may need to give your user account access to serial or audio devices.

Map packs are not included. An internet connection is needed to download a map or use an online map. In **Settings → Configure maps**, choose an area and detail level, then download it. Higher zoom levels and larger areas need more storage and can take a long time. Only one downloaded region is retained. You can instead configure online maps using your own Protomaps API key, or open a compatible local PMTiles pack in the map configurator. Windows map downloading requires the included Windows map helper; one successful Windows 11 download has been reported.

## Software updates

OpenBeacon checks GitHub for signed beta updates shortly after startup. When an update is available, open **Settings → Software updates** and choose **Download and install**. Stop automatic position and weather beaconing, and finish any active transmission or map download before installing. The app closes and restarts during installation. Your station settings, history, credentials and downloaded map are stored separately from the application files. Installation and recovery should still be checked on your computer.

The old portable beta does not include the updater; download and install an updater-enabled release once. The updater requires the Windows installer or Linux AppImage. A portable Linux executable can open the release page to download an AppImage instead. Checks require an internet connection and can be retried manually.

## Set up your station

1. Open **My Station** and enter your amateur callsign and SSID, then choose a symbol. An RF path and beacon comment are optional. Save your settings.
2. Open **GPS** and enter your station's latitude and longitude as decimal degrees, or connect a GPS receiver and wait for a fresh fix.
3. To receive online traffic, open **APRS-IS**, select a radius, and connect. The radius limits the APRS-IS server feed; it does not filter RF packets. The filter uses the GPS fix at connection time when available, otherwise the manual location. Reconnect to update its center.
4. To receive over the air, open **TNC**, select your interface and device, and connect. Configure your radio and TNC for the correct frequency and mode separately. Serial interfaces may require operating-system permissions. The bundled Dire Wolf audio receiver is Linux x86-64 only. Windows users can install and configure Dire Wolf separately, start it, then select **TCP KISS TNC** and connect to its configured address (normally `127.0.0.1:8001`). Dire Wolf handles the audio device and, if transmitting, PTT setup. External Dire Wolf and the Windows connection have not yet been verified with OpenBeacon; use a Dire Wolf version containing the relevant security fixes.

### Kenwood TM-D710 KISS setup

Connect the computer to the **COM port on the control head**, using the appropriate Kenwood serial cable; the PC port on the radio body is for radio control. Select the correct data band and APRS frequency on the radio and press **TNC** until it enters PACKET mode. The host serial speed and over-the-air packet speed are separate settings: the setup below uses 9600 baud on the computer port, while ordinary APRS generally uses 1200 baud over the air.

Before connecting OpenBeacon, use a serial terminal configured for the control-head COM port at 9600 baud, 8 data bits, no parity, one stop bit, and no flow control. Press Enter for the `cmd:` prompt, enter `KISS ON`, press Enter, then enter `RESTART` and press Enter. Close the terminal so it releases the port. In OpenBeacon's TNC settings choose **Serial KISS**, select **Kenwood TM-D710 (KISS receive and transmit)**, choose the same port, and connect. These commands change the radio's TNC mode; OpenBeacon does not issue them automatically or exit KISS when disconnected. To exit, disconnect OpenBeacon and use a serial utility to send the three bytes `C0 FF C0` (hex), the exit sequence specified in the [Kenwood guide](https://www.kenwood.com/i/products/info/amateur/pdf/TM-D710A_E_GA_GE_IDM.pdf). Return to the radio's APRS mode if desired. Record any existing radio settings before changing modes.

The owner's D710A has been observed receiving KISS frames, but OpenBeacon transmit through this model has not yet been verified on air. A successful send means the frame was handed to the TNC, not that another station received it. Some installations may supply GPS data only in APRS mode, not while in PACKET/KISS mode.

## Explore traffic

The map plots stations with valid positions. Select a station for its details, distance from your current GPS fix or manual location, and packet inspection. The **Stations** panel searches callsigns and can show RF-only stations. The **Traffic Monitor** lets you filter by source or packet type, search, pause, and inspect packets; packets without a reported position have no packet distance. The recent-packet strip has its own source filter. The map's clear control removes displayed stations and tracks, not saved history.

## Send position beacons

In **Beacon → Beacon settings**, choose APRS-IS or a supported RF TNC. An APRS-IS passcode is required for APRS-IS transmission and is saved in My Station. Check the station identity, location, symbol, comment and RF path before sending. Use **Send once** or start the fixed-position schedule. Fixed mode uses the saved manual position if available; otherwise it captures the current GPS position when started and stops if the fix becomes stale. Use mobile mode for a moving station. The Beacon menu can start or stop an automatic schedule; its indicator is green when a schedule is active. Stopping a schedule cannot recall a packet already handed to a TNC.

For mobile SmartBeaconing, connect a GPS source in **GPS**, choose mobile mode in Beacon settings, review its speed, interval and turn settings, and start it. A fresh GPS fix with speed and course is required. The schedule stops if the fix becomes stale. The operator reports successful RF and APRS-IS beaconing over approximately two days (October 28, 2026). Mobile operation and additional hardware combinations need further real-hardware testing.

## Connect a GPS or phone

In **GPS**, select a serial port, NMEA TCP server, UDP listener, or gpsd service. Serial and network NMEA sources must provide valid checksummed RMC sentences. Bluetooth Classic SPP requires the operating system to pair the device and expose its service as a serial port; pairing alone may not do this. NavCast on Android can share the phone's internal GPS using Bluetooth SPP, TCP or UDP. Enable RMC output and enter the corresponding serial port or network address in OpenBeacon. The phone integration has not yet been verified with physical hardware. See the README for connection details and limitations.

## Messages

Open **Messages** to read APRS messages addressed to your configured station. Choose APRS-IS or a supported RF TNC, enter the recipient and message, and send. RF messages have their own path selection. The outbox shows acknowledgements where available and offers manual resend; automatic retries are not implemented. Automatic acknowledgements are optional and can transmit over RF. The BBS inbox is a placeholder.

## Weather

Open **Weather** for the local NWS forecast and received weather stations. The forecast and personal weather sections can be collapsed. A forecast uses a current GPS fix or manual location and requires internet access within NWS coverage.

For your own station, configure a Weather Underground PWS station ID and API key or a supported Peet Bros serial device. Fetch and review the observation. Choose APRS-IS or RF and, for RF, select the weather path; this path and route are remembered. Send once, or configure the source and interval and start weather beaconing from Weather or the Beacon menu. Weather packets use your base callsign with SSID `-13`. Automatic weather beaconing runs only while the app is open, pauses on failed or stale observations, and retries at the next interval. Weather Underground credentials and serial hardware have not yet been verified with live devices in this project.

## Troubleshooting

- **No map:** Check your internet connection, map configuration and downloaded region. Online maps require a working API key. A freshly extracted release has no bundled map packs.
- **No APRS-IS stations:** Verify the callsign, GPS fix or manual location, radius and connection status. The radius applies only to the server feed.
- **No RF packets:** Check the radio frequency, audio or serial connection, TNC mode, baud rate and device permissions. Reception and transmit capabilities vary by interface.
- **GPS waiting:** Confirm the correct port or network endpoint, valid RMC output, and an actual satellite fix. GPSD and phone GPS support need hardware testing.
- **Beacon not sent:** Check the selected route, station settings, connection and status message. APRS-IS transmission needs a passcode; RF needs a connected transmitting TNC.

Refer to [README.md](README.md) for platform limitations, detailed source settings, privacy of stored credentials, and current hardware validation. Report issues with your OS, interface, steps and any error message; omit passcodes, API keys and private location data.
