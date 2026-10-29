# OpenBeacon user guide

OpenBeacon displays APRS traffic from the internet and from supported radio interfaces. It can also send position, message and weather packets when you configure a connection. Features run while the application is open.

## Starting the app

On Windows, run the OpenBeacon setup installer and follow its prompts. On Linux, mark the OpenBeacon AppImage executable and open it. Portable archives, when provided, must be extracted with their helper programs kept alongside the executable. Windows requires Microsoft Edge WebView2 and the installer may need an internet connection to install it. Linux needs the system WebKitGTK libraries; see the README for development prerequisites. You may need to give your user account access to serial or audio devices.

On a clean installation, the setup wizard introduces station identity, location or GPS, maps, and optional APRS-IS and radio connections. Each step can be skipped, and beaconing is not started by the wizard. An unfinished wizard resumes after a restart; use **Settings → Open setup wizard** to revisit it. Existing installations keep their settings.

A basic world overview through zoom level 6 is included for offline use. Download a regional map for street-level detail, or use an online map; both require an internet connection. In **Settings → Configure maps**, choose an area and detail level, then download it. Higher zoom levels and larger areas need more storage and can take a long time. If a large download fails, try again or select a smaller region; a retry starts over. Only one downloaded region is retained. You can instead configure online maps using your own Protomaps API key, or open a compatible local PMTiles pack in the map configurator. Windows map downloading requires the included Windows map helper; one successful Windows 11 download has been reported.

Use the dropdown beneath **Clear map** to show all sources, RF only, or direct RF. Direct RF includes RF packets whose paths do not mark a digipeater as having repeated them; unused paths such as `WIDE1-1` do not exclude a station. This depends on the received path being accurate and is not proof of a direct radio link. The choice changes the map display; it does not disconnect APRS-IS or remove stored packets.

## Software updates

OpenBeacon checks GitHub for signed updates shortly after startup. When an update is available, open **Settings → Software updates** and choose **Download and install**. Stop automatic position and weather beaconing, and finish any active transmission or map download before installing. The app closes and restarts during installation. Your station settings, history, credentials and downloaded map are stored separately from the application files. Installation and recovery should still be checked on your computer.

The old portable beta does not include the updater; download and install an updater-enabled release once. The updater requires the Windows installer or Linux AppImage. A portable Linux executable can open the release page to download an AppImage instead. Checks require an internet connection and can be retried manually.

## Set up your station

1. Open **My Station** and enter your amateur callsign and SSID, then choose a symbol. An RF path and beacon comment are optional. Save your settings.
2. Open **GPS** and enter your station's latitude and longitude as decimal degrees, or connect a GPS receiver and wait for a fresh fix.
3. To receive online traffic, open **APRS-IS**, select a radius, and connect. The radius limits the APRS-IS server feed; it does not filter RF packets. The filter uses the GPS fix at connection time when available, otherwise the manual location. Reconnect to update its center.
4. To receive over the air, open **TNC**, select your interface and device, and connect. Configure your radio and TNC for the correct frequency and mode separately. Serial interfaces may require operating-system permissions. The bundled Dire Wolf audio receiver is Linux x86-64 only. Windows users can install and configure Dire Wolf separately, start it, then select **TCP KISS TNC** and connect to its configured address (normally `127.0.0.1:8001`). Dire Wolf handles the audio device and, if transmitting, PTT setup. External Dire Wolf and the Windows connection have not yet been verified with OpenBeacon; use a Dire Wolf version containing the relevant security fixes.

### RF to APRS-IS iGate

In **TNC → RF → APRS-IS iGate**, start the gateway to upload eligible live packets received from a KISS TNC to the public APRS-IS network. The iGate uses the station callsign and saved APRS-IS passcode, and can use a different SSID with the same base callsign. Its optional startup checkbox reconnects the gateway when the app opens; the TNC receiver has a separate autoconnect setting. The gateway does not transmit APRS-IS packets over RF or replay saved history. Do not use a TNC configured for PASSALL. Live-network and broader hardware testing are still needed.

### Soundcard transmission and PTT (Linux bundled Dire Wolf)

In **TNC**, select the bundled Dire Wolf audio modem and choose your radio interface's audio input and output. PTT defaults to **receive only**. For transmit, select **VOX** if your radio or interface keys from audio, **Serial RTS / DTR** for a serial-controlled interface (Digirig commonly uses RTS), or **CM108 / CM119 GPIO** for a supported soundcard interface. Choose the correct serial port or GPIO pin and optional hidraw device; GPIO 3 is common. CM108 access may require an appropriate Linux udev rule. Avoid serial hardware flow control on a PTT line. Check audio levels and PTT with a suitable test setup before transmitting. One test held PTT until the USB interface was unplugged, and subsequent packets were not decoded by the nearby D710; the cause remains under investigation. These options need hardware validation; Windows currently requires an independently installed Dire Wolf configured for its audio and PTT, connected via TCP KISS.

### Kenwood TS-2000 KISS setup (experimental)

The TS-2000 shares its rear COM port with computer control. Enable its internal TNC and configure the data band and on-air packet rate for your station. Choose **Serial / USB KISS TNC → Kenwood TS-2000 / TS-2000X (KISS)** and match the COM speed and flow control to the radio. When OpenBeacon detects the command prompt, it enables and verifies the KISS setting, then asks you to power the radio off and on and select **Start receiver** again. If there is no prompt, the radio may already be in KISS mode, but a quiet serial connection does not confirm that. Powering the radio off exits KISS; see the [Kenwood manual](https://kasc.kenwood.com/files/prod/255/5/TS-2000_Instruction_Manual_B62-1221-50_English.pdf). The operator has received and transmitted a digipeated packet using TS-2000 KISS at 57,600 baud with hardware flow control; the new automatic setup still needs testing on the radio.

### Kenwood TM-D710 KISS setup

Connect the computer to the **COM port on the control head**, using the appropriate Kenwood serial cable; the PC port on the radio body is for radio control. Select the correct data band and APRS frequency on the radio and press **TNC** until it enters PACKET mode. The host serial speed and over-the-air packet speed are separate settings: the setup below uses 9600 baud on the computer port, while ordinary APRS generally uses 1200 baud over the air.

In OpenBeacon choose **Serial / USB KISS**, select **Kenwood TM-D710 (KISS receive and transmit)**, and select its serial port at 9600 baud with no flow control. On connection OpenBeacon probes for the TNC command prompt; if found, it sends `KISS ON` followed by `RESTART`. If no prompt appears, it assumes the radio may already be in KISS mode, which cannot be confirmed until packets are exchanged. OpenBeacon does not exit KISS when disconnected. To exit, disconnect OpenBeacon and use a serial utility to send the three bytes `C0 FF C0` (hex), the exit sequence specified in the [Kenwood guide](https://www.kenwood.com/i/products/info/amateur/pdf/TM-D710A_E_GA_GE_IDM.pdf). Return to the radio's APRS mode if desired. Record any existing radio settings before changing modes.

The owner reports successful OpenBeacon receive and transmit with a D710A in KISS mode. A successful send means the frame was handed to the TNC, not that another station received it. Some installations may supply GPS data only in APRS mode, not while in PACKET/KISS mode.

## Explore traffic

The map plots stations with valid positions. Select a station for its details, distance from your current GPS fix or manual location, and packet inspection. The **Stations** panel searches callsigns and can show RF-only stations. The **Traffic Monitor** lets you filter by source or packet type, search, pause, and inspect packets; packets without a reported position have no packet distance. The recent-packet strip has its own source filter. The map's clear control removes displayed stations and tracks, not saved history.

## Send position beacons

In **Beacon → Beacon settings**, choose APRS-IS or a supported RF TNC, then choose the **Fixed** or **GPS / Mobile** tab. An APRS-IS passcode is required for APRS-IS transmission and is saved in My Station. Check the station identity, location, symbol, comment and RF path before sending. In Fixed, **Set fixed location on map** saves a position selected by clicking the map. Use **Send once** or **Start auto** to begin the chosen schedule. Fixed mode uses the saved manual position if available; otherwise it captures the current GPS position when started and stops if the GPS fix becomes stale. Use GPS / Mobile mode for a moving station. The Beacon menu can start or stop an automatic schedule; its indicator is green when a schedule is active. **Stop all beacons** in the header stops both position and weather schedules. Stopping a schedule cannot recall a packet already handed to a TNC. Position and weather schedules always start stopped when OpenBeacon opens; start them again when desired. A radio or TNC may still transmit packets already queued or run its own beacon independently.

For mobile SmartBeaconing, connect a GPS source in **GPS**, choose mobile mode in Beacon settings, review its speed, interval and turn settings, and start it. A fresh GPS fix with speed and course is required. The schedule stops if the fix becomes stale. The operator reports successful RF and APRS-IS beaconing over approximately two days (October 28, 2026). Mobile operation and additional hardware combinations need further real-hardware testing.

## Connect a GPS or phone

In **GPS**, select a serial port, NMEA TCP server, UDP listener, or gpsd service. Serial and network NMEA sources must provide valid checksummed RMC sentences. Bluetooth Classic SPP requires the operating system to pair the device and expose its service as a serial port; pairing alone may not do this. NavCast on Android can share the phone's internal GPS using Bluetooth SPP, TCP or UDP. Enable RMC output and enter the corresponding serial port or network address in OpenBeacon. The phone integration has not yet been verified with physical hardware. See the README for connection details and limitations.

## Messages

Open **Messages** to read APRS messages addressed to your configured station. Select **New message**, choose APRS-IS or a supported RF TNC, enter the recipient and message, and send. RF messages have their own path selection. The outbox shows acknowledgements where available and offers manual resend; automatic retries are not implemented. Automatic acknowledgements are optional and can transmit over RF. Packet BBS access is not yet available.

## Weather

Open **Weather** for the local NWS forecast and received weather stations. The forecast and personal weather sections can be collapsed, and their state is remembered. A forecast uses a current GPS fix or manual location and requires internet access within NWS coverage. The Stations, Weather and Traffic Monitor source controls offer all, RF, and direct RF views; direct RF relies on the TNC's reported digipeater-used markers.

For your own station, configure a Weather Underground PWS station ID and API key or a supported Peet Bros serial device. Fetch and review the observation. Choose APRS-IS or RF and, for RF, select the weather path; this path and route are remembered. Send once, or configure the source and interval and start weather beaconing from Weather or the Beacon menu. Weather packets use your base callsign with SSID `-13`. Automatic weather beaconing runs only while the app is open, pauses on failed or stale observations, and retries at the next interval. Weather Underground credentials and serial hardware have not yet been verified with live devices in this project.

## Troubleshooting

- **No map:** Check your internet connection, map configuration and downloaded region. Online maps require a working API key. The bundled world overview has limited detail; download a region for closer zoom levels.
- **No APRS-IS stations:** Verify the callsign, GPS fix or manual location, radius and connection status. The radius applies only to the server feed.
- **No RF packets:** Check the radio frequency, audio or serial connection, TNC mode, baud rate and device permissions. Reception and transmit capabilities vary by interface.
- **GPS waiting:** Confirm the correct port or network endpoint, valid RMC output, and an actual satellite fix. GPSD and phone GPS support need hardware testing.
- **Beacon not sent:** Check the selected route, station settings, connection and status message. APRS-IS transmission needs a passcode; RF needs a connected transmitting TNC.

Refer to [README.md](README.md) for platform limitations, detailed source settings, privacy of stored credentials, and current hardware validation. Report issues with your OS, interface, steps and any error message; omit passcodes, API keys and private location data.
