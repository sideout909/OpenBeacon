//! One socket owner for APRS-IS reception, locally generated sends and RF uploads.
//! No APRS-IS packets are ever submitted to RF or another internet connection.
use crate::aprs_login::{parse_login_response, LoginStatus};
use openbeacon_packet::{
    aprs::DecodedPacket,
    tnc2::{Line, LineDecoder},
};
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender, SyncSender},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const LOGIN_TIMEOUT: Duration = Duration::from_secs(8);
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
const RF_MAX_AGE: Duration = Duration::from_secs(2);

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Credentials {
    pub call: String,
    pub pass: Option<String>,
}
#[derive(Clone)]
pub(crate) struct ReceiveConfig {
    pub credentials: Credentials,
    pub lat: f64,
    pub lon: f64,
    pub radius: u32,
}
#[derive(Debug)]
enum Event {
    ReceiveStatus(u64, &'static str, String),
    IgateStatus(u64, &'static str, String, u64, u64),
    Packets(u64, Vec<Vec<u8>>),
}

type Reply<T> = Sender<Result<T, String>>;
enum Command {
    Receive(Option<ReceiveConfig>, Reply<u64>),
    Igate(Option<Credentials>, Reply<u64>),
    Send(Credentials, String, Instant, Reply<String>),
    Rf(u64, Instant, Box<DecodedPacket>),
    CredentialsChanged(String, Option<String>, Reply<()>),
    Shutdown(Reply<()>),
}

#[derive(Clone)]
pub(crate) struct Client {
    commands: SyncSender<Command>,
    // Zero while disconnected, logging in, unverified, or iGating is disabled.
    rf_session: Arc<AtomicU64>,
}
#[derive(Default)]
pub(crate) struct AprsSession(Mutex<Option<Client>>);

impl AprsSession {
    pub(crate) fn client(&self, app: &tauri::AppHandle) -> Result<Client, String> {
        let mut guard = self.0.lock().map_err(|_| "APRS-IS manager unavailable")?;
        if let Some(client) = &*guard {
            return Ok(client.clone());
        }
        let app = app.clone();
        let client = Client::start(connect_server, move |event| match event {
            Event::ReceiveStatus(generation, state, message) => {
                crate::emit_status(&app, generation, state, &message)
            }
            Event::IgateStatus(generation, state, message, forwarded, skipped) => {
                crate::igate::report(&app, generation, state, &message, forwarded, skipped)
            }
            Event::Packets(generation, lines) => {
                let packets: Vec<_> = lines
                    .iter()
                    .map(|line| {
                        let mut packet = openbeacon_packet::aprs::decode_tnc2(line);
                        packet.origin = openbeacon_packet::aprs::PacketOrigin::AprsIs;
                        packet
                    })
                    .collect();
                if let Err(error) = crate::history::save(&app, &packets) {
                    let _ = app.emit("history-error", error);
                }
                let _ = app.emit(
                    "aprs-packets",
                    crate::Packets {
                        generation,
                        packets,
                    },
                );
            }
        });
        *guard = Some(client.clone());
        Ok(client)
    }
    pub(crate) fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(client) = guard.take() {
                client.rf_session.store(0, Ordering::SeqCst);
                let _ = client.request(Command::Shutdown);
            }
        }
    }
}
pub(crate) fn client(app: &tauri::AppHandle) -> Result<Client, String> {
    app.state::<AprsSession>().client(app)
}

impl Client {
    fn start(
        connector: impl Fn() -> Result<TcpStream, String> + Send + 'static,
        events: impl Fn(Event) + Send + 'static,
    ) -> Self {
        let (commands, receiver) = mpsc::sync_channel(256);
        let rf_session = Arc::new(AtomicU64::new(0));
        let ready = rf_session.clone();
        std::thread::spawn(move || Worker::new(receiver, ready, connector, events).run());
        Self {
            commands,
            rf_session,
        }
    }
    fn request<T>(&self, command: impl FnOnce(Reply<T>) -> Command) -> Result<T, String> {
        let (tx, rx) = mpsc::channel();
        self.commands
            .send(command(tx))
            .map_err(|_| "APRS-IS manager stopped")?;
        rx.recv().map_err(|_| "APRS-IS manager stopped")?
    }
    pub(crate) fn receive(&self, settings: Option<ReceiveConfig>) -> Result<u64, String> {
        self.request(|reply| Command::Receive(settings, reply))
    }
    pub(crate) fn igate(&self, settings: Option<Credentials>) -> Result<u64, String> {
        self.request(|reply| Command::Igate(settings, reply))
    }
    pub(crate) fn send(&self, credentials: Credentials, payload: String) -> Result<String, String> {
        let deadline = Instant::now() + SEND_TIMEOUT;
        self.request(|reply| Command::Send(credentials, payload, deadline, reply))
    }
    pub(crate) fn offer(&self, packets: &[DecodedPacket]) {
        let epoch = self.rf_session.load(Ordering::SeqCst);
        if epoch == 0 {
            return;
        }
        for packet in packets {
            let _ = self.commands.try_send(Command::Rf(
                epoch,
                Instant::now(),
                Box::new(packet.clone()),
            ));
        }
    }
    pub(crate) fn credentials_changed(
        &self,
        call: String,
        pass: Option<String>,
    ) -> Result<(), String> {
        self.request(|reply| Command::CredentialsChanged(call, pass, reply))
    }
}
fn connect_server() -> Result<TcpStream, String> {
    // Resolve on every attempt. Try each returned address, never in parallel.
    let addresses = ("rotate.aprs2.net", 14580)
        .to_socket_addrs()
        .map_err(|e| e.to_string())?;
    let mut error = "Could not resolve APRS-IS".to_string();
    for address in addresses.take(4) {
        match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
            Ok(stream) => return Ok(stream),
            Err(e) => error = e.to_string(),
        }
    }
    Err(error)
}
fn same_base(a: &str, b: &str) -> bool {
    a.split('-').next() == b.split('-').next()
}

struct PendingSend {
    credentials: Credentials,
    payload: String,
    deadline: Instant,
    reply: Reply<String>,
}
struct Socket {
    stream: TcpStream,
    credentials: Credentials,
    login: Option<LoginStatus>,
    framing: LineDecoder,
    opened: Instant,
    last_read: Instant,
    filter: String,
}
impl Drop for Socket {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}
struct Worker<C, E> {
    commands: Receiver<Command>,
    rf_session: Arc<AtomicU64>,
    connector: C,
    events: E,
    receive: Option<ReceiveConfig>,
    igate: Option<Credentials>,
    send_identity: Option<Credentials>,
    receive_generation: u64,
    igate_generation: u64,
    epoch: u64,
    forwarded: u64,
    skipped: u64,
    pending: Vec<PendingSend>,
    socket: Option<Socket>,
    retry_at: Instant,
    retry_seconds: u64,
    last_send: Instant,
}
impl<C, E> Worker<C, E>
where
    C: Fn() -> Result<TcpStream, String>,
    E: Fn(Event),
{
    fn new(
        commands: Receiver<Command>,
        rf_session: Arc<AtomicU64>,
        connector: C,
        events: E,
    ) -> Self {
        Self {
            commands,
            rf_session,
            connector,
            events,
            receive: None,
            igate: None,
            send_identity: None,
            receive_generation: 0,
            igate_generation: 0,
            epoch: 0,
            forwarded: 0,
            skipped: 0,
            pending: Vec::new(),
            socket: None,
            retry_at: Instant::now(),
            retry_seconds: 1,
            last_send: Instant::now(),
        }
    }
    fn identity(&self) -> Option<Credentials> {
        self.igate
            .clone()
            .or_else(|| self.receive.as_ref().map(|r| r.credentials.clone()))
            .or_else(|| self.send_identity.clone())
            .or_else(|| self.pending.first().map(|send| send.credentials.clone()))
    }
    fn filter(&self, login: &str) -> String {
        match &self.receive {
            Some(r) => format!(
                "r/{:.5}/{:.5}/{} g/{}/{}",
                r.lat, r.lon, r.radius, r.credentials.call, login
            ),
            None => format!("g/{login}"),
        }
    }
    fn status(&self, state: &'static str, message: &str) {
        if self.receive.is_some() {
            (self.events)(Event::ReceiveStatus(
                self.receive_generation,
                state,
                message.into(),
            ));
        }
        if self.igate.is_some() {
            (self.events)(Event::IgateStatus(
                self.igate_generation,
                state,
                message.into(),
                self.forwarded,
                self.skipped,
            ));
        }
    }
    fn connected_status(&self) {
        let verified = self
            .socket
            .as_ref()
            .is_some_and(|s| s.login == Some(LoginStatus::Verified));
        if self.receive.is_some() {
            let call = self
                .socket
                .as_ref()
                .map(|s| s.credentials.call.as_str())
                .unwrap_or("");
            let message = if verified {
                format!("Connected · verified as {call} · shared APRS-IS session")
            } else {
                format!("Connected as {call} · receive only · login not verified")
            };
            (self.events)(Event::ReceiveStatus(
                self.receive_generation,
                "connected",
                message,
            ));
        }
        if self.igate.is_some() {
            let (state, message) = if verified {
                (
                    "connected",
                    "Verified · forwarding live RF on shared APRS-IS session",
                )
            } else {
                ("error", "APRS-IS login is not verified; RF forwarding is paused. Check the saved passcode.")
            };
            (self.events)(Event::IgateStatus(
                self.igate_generation,
                state,
                message.into(),
                self.forwarded,
                self.skipped,
            ));
        }
    }
    fn close(&mut self) {
        self.rf_session.store(0, Ordering::SeqCst);
        self.socket = None; // Drop/shutdown completes before any connector call.
    }
    fn fail_pending(&mut self, error: &str) {
        for send in self.pending.drain(..) {
            let _ = send.reply.send(Err(error.into()));
        }
    }
    fn reconnect(&mut self) {
        self.close();
        self.retry_at = Instant::now();
        self.retry_seconds = 1;
    }
    fn failed(&mut self, error: &str) {
        self.close();
        self.fail_pending(error);
        self.status(
            "reconnecting",
            &format!(
                "{error} Retrying in {}s; RF packets are not queued.",
                self.retry_seconds
            ),
        );
        self.retry_at = Instant::now() + Duration::from_secs(self.retry_seconds);
        self.retry_seconds = (self.retry_seconds * 2).min(30);
    }
    fn update_ready(&mut self) {
        let ready = self.igate.is_some()
            && self
                .socket
                .as_ref()
                .is_some_and(|s| s.login == Some(LoginStatus::Verified));
        self.rf_session
            .store(if ready { self.epoch } else { 0 }, Ordering::SeqCst);
    }
    fn incompatible(&self, call: &str) -> bool {
        self.receive
            .as_ref()
            .is_some_and(|r| !same_base(&r.credentials.call, call))
            || self
                .igate
                .as_ref()
                .is_some_and(|i| !same_base(&i.call, call))
    }
    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Shutdown(reply) => {
                self.close();
                self.fail_pending("Application is closing; no packet sent.");
                let _ = reply.send(Ok(()));
                return false;
            }
            Command::Receive(config, reply) => {
                if config.as_ref().is_some_and(|r| {
                    self.igate
                        .as_ref()
                        .is_some_and(|i| !same_base(&r.credentials.call, &i.call))
                }) {
                    let _ = reply.send(Err("Use the same base callsign for APRS-IS and the iGate, or stop the iGate first.".into()));
                    return true;
                }
                self.receive_generation += 1;
                self.receive = config;
                // An explicit disconnect must not leave an idle send-only session behind.
                self.send_identity = None;
                self.retry_at = Instant::now();
                if self.socket.as_ref().is_some_and(|s| s.login.is_some()) {
                    self.connected_status();
                }
                let _ = reply.send(Ok(self.receive_generation));
            }
            Command::Igate(config, reply) => {
                if config.as_ref().is_some_and(|i| {
                    self.receive
                        .as_ref()
                        .is_some_and(|r| !same_base(&r.credentials.call, &i.call))
                }) {
                    let _ = reply.send(Err(
                        "Use the same base callsign for the iGate and My Station.".into(),
                    ));
                    return true;
                }
                self.igate_generation += 1;
                self.igate = config;
                self.forwarded = 0;
                self.skipped = 0;
                // Epoch invalidation also cancels RF commands from the previous iGate.
                self.rf_session.store(0, Ordering::SeqCst);
                self.epoch += 1;
                self.send_identity = None;
                self.retry_at = Instant::now();
                if self.socket.as_ref().is_some_and(|s| {
                    s.login.is_some() && Some(&s.credentials) == self.identity().as_ref()
                }) {
                    self.connected_status();
                }
                let _ = reply.send(Ok(self.igate_generation));
            }
            Command::Send(credentials, payload, deadline, reply) => {
                if self.incompatible(&credentials.call) {
                    let _ = reply.send(Err("The APRS-IS connection belongs to a different base callsign. Disconnect it and stop the iGate first.".into()));
                    return true;
                }
                if credentials.pass.is_none() || self.pending.len() >= 32 {
                    let _ = reply.send(Err(
                        "A saved passcode and space in the send queue are required.".into(),
                    ));
                    return true;
                }
                if payload.is_empty() || payload.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
                {
                    let _ = reply.send(Err("Invalid APRS payload.".into()));
                    return true;
                }
                if let Some(r) = &mut self.receive {
                    r.credentials.pass.clone_from(&credentials.pass);
                }
                if let Some(i) = &mut self.igate {
                    i.pass.clone_from(&credentials.pass);
                }
                match &mut self.send_identity {
                    Some(identity) if same_base(&identity.call, &credentials.call) => {
                        identity.pass.clone_from(&credentials.pass);
                    }
                    _ => self.send_identity = Some(credentials.clone()),
                }
                self.last_send = Instant::now();
                self.pending.push(PendingSend {
                    credentials,
                    payload,
                    deadline,
                    reply,
                });
                // User sends may establish or upgrade the one session; no separate send socket.
                self.retry_at = Instant::now();
            }
            Command::Rf(epoch, received, packet) => {
                if epoch != self.epoch
                    || received.elapsed() >= RF_MAX_AGE
                    || self.rf_session.load(Ordering::SeqCst) == 0
                {
                    self.skipped += 1;
                    return true;
                }
                if let Some(igate) = &self.igate {
                    if let Some(line) = crate::igate::format_packet(&packet, &igate.call) {
                        let result = self.socket.as_mut().unwrap().stream.write_all(&line);
                        if result.is_err() {
                            self.failed("RF upload failed; outcome may be unknown.");
                        } else {
                            self.forwarded += 1;
                            self.connected_status();
                        }
                    } else {
                        self.skipped += 1;
                    }
                }
            }
            Command::CredentialsChanged(call, pass, reply) => {
                for credentials in self
                    .receive
                    .iter_mut()
                    .map(|r| &mut r.credentials)
                    .chain(self.igate.iter_mut())
                    .chain(self.send_identity.iter_mut())
                {
                    if same_base(&credentials.call, &call) {
                        credentials.pass.clone_from(&pass);
                    }
                }
                self.reconnect();
                let _ = reply.send(Ok(()));
            }
        }
        true
    }
    fn open(&mut self, credentials: Credentials) -> Result<(), String> {
        let mut stream = (self.connector)()?;
        stream.set_nodelay(true).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_millis(20)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let filter = self.filter(&credentials.call);
        write!(
            stream,
            "user {} pass {} vers OpenBeacon {} filter {}\r\n",
            credentials.call,
            credentials.pass.as_deref().unwrap_or("-1"),
            env!("CARGO_PKG_VERSION"),
            filter
        )
        .map_err(|e| e.to_string())?;
        self.epoch += 1;
        self.socket = Some(Socket {
            stream,
            credentials,
            login: None,
            framing: LineDecoder::default(),
            opened: Instant::now(),
            last_read: Instant::now(),
            filter,
        });
        self.status("connecting", "Waiting for APRS-IS login…");
        Ok(())
    }
    fn poll(&mut self) -> Result<(), String> {
        let mut lines = Vec::new();
        let mut login_changed = false;
        let socket = self.socket.as_mut().unwrap();
        let mut bytes = [0; 8192];
        match socket.stream.read(&mut bytes) {
            Ok(0) => return Err("APRS-IS disconnected.".into()),
            Ok(n) => {
                socket.last_read = Instant::now();
                for line in socket.framing.feed(&bytes[..n]) {
                    if let Line::Data(line) = line {
                        if let Some(login) = parse_login_response(&line, &socket.credentials.call) {
                            socket.login = Some(login);
                            login_changed = true;
                        } else if socket.login.is_some() && !line.starts_with(b"#") {
                            lines.push(line);
                        }
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(format!("APRS-IS read failed: {e}")),
        }
        if socket.login.is_none() && socket.opened.elapsed() >= LOGIN_TIMEOUT {
            return Err("APRS-IS login timed out.".into());
        }
        if socket.last_read.elapsed() >= Duration::from_secs(120) {
            return Err("APRS-IS keepalive timed out.".into());
        }
        if login_changed {
            self.retry_seconds = 1;
            self.update_ready();
            self.connected_status();
        }
        if !lines.is_empty() && self.receive.is_some() {
            (self.events)(Event::Packets(self.receive_generation, lines));
        }
        Ok(())
    }
    fn flush_sends(&mut self) {
        let login = self.socket.as_ref().and_then(|s| s.login.as_ref());
        if login == Some(&LoginStatus::Unverified) {
            self.fail_pending(
                "APRS-IS did not verify the login; no packet sent. Check the saved passcode.",
            );
            return;
        }
        if login != Some(&LoginStatus::Verified) {
            return;
        }
        while !self.pending.is_empty() {
            let send = self.pending.remove(0);
            if Instant::now() >= send.deadline {
                let _ = send.reply.send(Err(
                    "Send expired before transmission; no packet sent.".into()
                ));
                continue;
            }
            if self.incompatible(&send.credentials.call) {
                let _ = send
                    .reply
                    .send(Err("Station identity changed; no packet sent.".into()));
                continue;
            }
            let packet = format!(
                "{}>{},TCPIP*:{}",
                send.credentials.call,
                crate::TOCALL,
                send.payload
            );
            let result = self
                .socket
                .as_mut()
                .unwrap()
                .stream
                .write_all(format!("{packet}\r\n").as_bytes());
            if let Err(e) = result {
                let _ = send
                    .reply
                    .send(Err(format!("Send failed; outcome may be unknown: {e}")));
                self.failed("APRS-IS send failed; unsent packets were cancelled.");
                break;
            }
            self.last_send = Instant::now();
            let _ = send.reply.send(Ok(packet));
        }
    }
    fn run(mut self) {
        loop {
            let timeout = if self.socket.is_some() {
                Duration::from_millis(1)
            } else {
                Duration::from_millis(50)
            };
            match self.commands.recv_timeout(timeout) {
                Ok(command) => {
                    if !self.handle(command) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            // Bound draining so incoming data and keepalives cannot starve.
            for _ in 0..31 {
                match self.commands.try_recv() {
                    Ok(command) => {
                        if !self.handle(command) {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let now = Instant::now();
            self.pending.retain(|send| {
                if now >= send.deadline {
                    let _ = send.reply.send(Err(
                        "Send expired before transmission; no packet sent.".into(),
                    ));
                    false
                } else {
                    true
                }
            });
            if self.receive.is_none()
                && self.igate.is_none()
                && self.pending.is_empty()
                && self.last_send.elapsed() > Duration::from_secs(30)
            {
                self.send_identity = None;
            }
            let desired = self.identity();
            if self
                .socket
                .as_ref()
                .is_some_and(|s| Some(&s.credentials) != desired.as_ref())
            {
                self.reconnect();
            }
            if desired.is_none() {
                self.close();
                continue;
            }
            if self.socket.is_none() && Instant::now() >= self.retry_at {
                self.status("connecting", "Connecting to shared APRS-IS session…");
                if let Err(error) = self.open(desired.unwrap()) {
                    self.failed(&error);
                }
                // Process control changes before any packets can be written.
                continue;
            }
            if let Some(socket) = &self.socket {
                let filter = self.filter(&socket.credentials.call);
                if socket.filter != filter && socket.login.is_some() {
                    let socket = self.socket.as_mut().unwrap();
                    if socket
                        .stream
                        .write_all(format!("#filter {filter}\r\n").as_bytes())
                        .is_err()
                    {
                        self.failed("Could not update APRS-IS filter.");
                        continue;
                    }
                    socket.filter = filter;
                    self.connected_status();
                }
                self.update_ready();
                if let Err(error) = self.poll() {
                    self.failed(&error);
                    continue;
                }
                self.flush_sends();
            }
        }
        self.close();
        self.fail_pending("APRS-IS manager stopped; no packet sent.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::atomic::AtomicUsize,
    };

    fn credentials(call: &str, pass: Option<&str>) -> Credentials {
        Credentials {
            call: call.into(),
            pass: pass.map(str::to_string),
        }
    }
    fn reception(call: &str, pass: Option<&str>) -> ReceiveConfig {
        ReceiveConfig {
            credentials: credentials(call, pass),
            lat: 42.0,
            lon: -83.0,
            radius: 50,
        }
    }
    struct Harness {
        listener: TcpListener,
        client: Client,
        events: Receiver<Event>,
        connections: Arc<AtomicUsize>,
    }
    impl Harness {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let connections = Arc::new(AtomicUsize::new(0));
            let count = connections.clone();
            let (tx, events) = mpsc::channel();
            let client = Client::start(
                move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    TcpStream::connect_timeout(&address, Duration::from_secs(1))
                        .map_err(|e| e.to_string())
                },
                move |event| {
                    let _ = tx.send(event);
                },
            );
            Self {
                listener,
                client,
                events,
                connections,
            }
        }
        fn accept(&self) -> Peer {
            let until = Instant::now() + Duration::from_secs(3);
            loop {
                match self.listener.accept() {
                    Ok((stream, _)) => return Peer::new(stream),
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < until =>
                    {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("accept: {e}"),
                }
            }
        }
        fn wait(&self, predicate: impl Fn(&Event) -> bool) -> Event {
            let until = Instant::now() + Duration::from_secs(3);
            loop {
                let event = self
                    .events
                    .recv_timeout(until.saturating_duration_since(Instant::now()))
                    .expect("expected session event");
                if predicate(&event) {
                    return event;
                }
            }
        }
        fn stop(&self) {
            self.client.request(Command::Shutdown).unwrap();
        }
    }
    struct Peer(BufReader<TcpStream>);
    impl Peer {
        fn new(stream: TcpStream) -> Self {
            // Winsock accept inherits the listener's nonblocking mode. The test
            // peer uses blocking reads with deadlines on every platform.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            Self(BufReader::new(stream))
        }
        fn line(&mut self) -> Vec<u8> {
            let mut line = Vec::new();
            self.0.read_until(b'\n', &mut line).unwrap();
            line
        }
        fn write(&mut self, bytes: &[u8]) {
            self.0.get_mut().write_all(bytes).unwrap();
        }
        fn login(&mut self, call: &str, pass: &str, verified: bool) {
            let line = self.line();
            assert!(
                line.starts_with(format!("user {call} pass {pass} vers OpenBeacon ").as_bytes()),
                "{}",
                String::from_utf8_lossy(&line)
            );
            self.write(
                format!(
                    "# logresp {call} {}, server test\r\n",
                    if verified { "verified" } else { "unverified" }
                )
                .as_bytes(),
            );
        }
    }
    fn rf(payload: &[u8]) -> DecodedPacket {
        let mut frame = Vec::new();
        for (call, last) in [("APTEST", false), ("K9ABC", true)] {
            frame.extend(format!("{call:<6}").bytes().map(|b| b << 1));
            frame.push(0x60 | u8::from(last));
        }
        frame.extend([3, 0xf0]);
        frame.extend(payload);
        openbeacon_packet::aprs::decode_rf_frame(&frame, false)
            .unwrap()
            .1
    }
    fn spawn_send(
        client: &Client,
        call: &str,
        payload: &str,
    ) -> std::thread::JoinHandle<Result<String, String>> {
        let client = client.clone();
        let call = call.to_string();
        let payload = payload.to_string();
        std::thread::spawn(move || client.send(credentials(&call, Some("123")), payload))
    }

    #[test]
    fn test_peer_waits_for_delayed_data_on_an_initially_nonblocking_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let sender = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            stream.write_all(b"delayed packet\r\n").unwrap();
        });
        let (stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(true).unwrap();
        let mut peer = Peer::new(stream);
        assert_eq!(peer.line(), b"delayed packet\r\n");
        sender.join().unwrap();
    }

    #[test]
    fn one_verified_socket_serves_reception_igate_and_all_local_packet_types() {
        let h = Harness::new();
        h.client
            .igate(Some(credentials("N0ABC-15", Some("123"))))
            .unwrap();
        let mut peer = h.accept();
        peer.login("N0ABC-15", "123", true);
        h.wait(|e| matches!(e, Event::IgateStatus(_, "connected", _, _, _)));
        let generation = h
            .client
            .receive(Some(reception("N0ABC-1", Some("123"))))
            .unwrap();
        assert_eq!(
            peer.line(),
            b"#filter r/42.00000/-83.00000/50 g/N0ABC-1/N0ABC-15\r\n"
        );
        // A fragmented binary packet shares the stream with status/comments.
        peer.write(b"K8ABC>APTEST:!\xff\0");
        peer.write(b"  \r\n# keepalive\r\n");
        let Event::Packets(g, packets) = h.wait(|e| matches!(e, Event::Packets(_, _))) else {
            unreachable!()
        };
        assert_eq!(g, generation);
        assert_eq!(packets, vec![b"K8ABC>APTEST:!\xff\0  ".to_vec()]);
        let outgoing = [
            ("N0ABC-1", "!position"),
            ("N0ABC-13", "_weather"),
            ("N0ABC-1", ":K8ABC    :hello{1"),
        ];
        let sends: Vec<_> = outgoing
            .iter()
            .map(|(call, payload)| spawn_send(&h.client, call, payload))
            .collect();
        let mut written: Vec<_> = (0..3).map(|_| peer.line()).collect();
        let mut expected: Vec<_> = outgoing
            .iter()
            .map(|(call, payload)| format!("{call}>APOBCN,TCPIP*:{payload}\r\n").into_bytes())
            .collect();
        written.sort();
        expected.sort();
        assert_eq!(written, expected);
        for send in sends {
            send.join().unwrap().unwrap();
        }
        // RX iGates must pass repeated RF packets, preserving the original TOCALL and bytes.
        h.client.offer(&[rf(b"!\xff\0 x  "), rf(b"!\xff\0 x  ")]);
        for _ in 0..2 {
            assert_eq!(peer.line(), b"K9ABC>APTEST,qAO,N0ABC-15:!\xff\0 x  \r\n");
        }
        h.client.receive(None).unwrap();
        assert_eq!(peer.line(), b"#filter g/N0ABC-15\r\n");
        h.client.offer(&[rf(b"!still-gating")]);
        assert_eq!(peer.line(), b"K9ABC>APTEST,qAO,N0ABC-15:!still-gating\r\n");
        h.client.igate(None).unwrap();
        assert!(peer.line().is_empty());
        assert_eq!(h.connections.load(Ordering::SeqCst), 1);
        h.stop();
    }

    #[test]
    fn verified_login_is_required_before_any_transmission() {
        let h = Harness::new();
        h.client.receive(Some(reception("N0ABC-1", None))).unwrap();
        let mut peer = h.accept();
        peer.login("N0ABC-1", "-1", false);
        h.wait(|e| matches!(e, Event::ReceiveStatus(_, "connected", _)));
        peer.write(b"K8ABC>APTEST:>receive-only works\r\n");
        h.wait(|e| matches!(e, Event::Packets(_, _)));
        let send = spawn_send(&h.client, "N0ABC-13", "_weather");
        assert!(peer.line().is_empty()); // Old connection closes before the verified replacement.
        let mut replacement = h.accept();
        let login = replacement.line();
        assert!(login.starts_with(b"user N0ABC-1 pass 123 "));
        replacement
            .0
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        assert!(replacement.0.read_until(b'\n', &mut Vec::new()).is_err());
        // Neither a different SSID nor a similar-looking status authorizes transmission.
        replacement.write(b"# logresp N0ABC-15 verified, server test\r\n# logresp N0ABC-1 notverified, server test\r\n");
        assert!(replacement.0.read_until(b'\n', &mut Vec::new()).is_err());
        replacement.write(b"# logresp N0ABC-1 unverified, server test\r\n");
        assert!(send.join().unwrap().unwrap_err().contains("did not verify"));
        replacement
            .0
            .get_mut()
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        h.client
            .credentials_changed("N0ABC".into(), Some("456".into()))
            .unwrap();
        assert!(replacement.line().is_empty());
        let mut verified = h.accept();
        verified.login("N0ABC-1", "456", true);
        h.wait(|e| matches!(e, Event::ReceiveStatus(_, "connected", message) if message.contains("verified as N0ABC-1 · shared")));
        h.stop();
        assert!(verified.line().is_empty());
    }

    #[test]
    fn changing_igate_ssid_closes_old_socket_and_preserves_receive_subscription() {
        let h = Harness::new();
        h.client
            .receive(Some(reception("N0ABC-1", Some("123"))))
            .unwrap();
        let mut rx = h.accept();
        rx.login("N0ABC-1", "123", true);
        h.wait(|e| matches!(e, Event::ReceiveStatus(_, "connected", _)));
        h.client
            .igate(Some(credentials("N0ABC-15", Some("123"))))
            .unwrap();
        assert!(rx.line().is_empty());
        let mut gate = h.accept();
        let login = gate.line();
        assert!(login.starts_with(b"user N0ABC-15 pass 123 "));
        assert!(String::from_utf8_lossy(&login).contains("g/N0ABC-1/N0ABC-15"));
        gate.write(b"# logresp N0ABC-15 verified, server test\r\n");
        h.wait(|e| matches!(e, Event::IgateStatus(_, "connected", _, _, _)));
        assert!(h
            .client
            .igate(Some(credentials("K8XYZ-15", Some("123"))))
            .is_err());
        assert!(h
            .client
            .send(credentials("K8XYZ-1", Some("123")), "!wrong station".into())
            .is_err());
        h.client.igate(None).unwrap();
        assert!(gate.line().is_empty());
        let mut restored = h.accept();
        restored.login("N0ABC-1", "123", true);
        h.wait(|e| matches!(e, Event::ReceiveStatus(_, "connected", _)));
        restored.write(b"K8ABC>APTEST:>still receiving\r\n");
        h.wait(|e| matches!(e, Event::Packets(_, _)));
        h.client.receive(None).unwrap();
        assert!(restored.line().is_empty());
        assert_eq!(h.connections.load(Ordering::SeqCst), 3);
        h.stop();
    }

    #[test]
    fn reconnect_discards_offline_old_session_and_stale_rf_packets() {
        let h = Harness::new();
        h.client
            .igate(Some(credentials("N0ABC-15", Some("123"))))
            .unwrap();
        let mut first = h.accept();
        first.login("N0ABC-15", "123", true);
        h.wait(|e| matches!(e, Event::IgateStatus(_, "connected", _, _, _)));
        let old_epoch = h.client.rf_session.load(Ordering::SeqCst);
        first.0.get_mut().shutdown(Shutdown::Both).unwrap();
        h.wait(|e| matches!(e, Event::IgateStatus(_, "reconnecting", _, _, _)));
        assert_eq!(h.client.rf_session.load(Ordering::SeqCst), 0);
        h.client.offer(&[rf(b"!offline")]);
        let mut second = h.accept();
        second.login("N0ABC-15", "123", true);
        h.wait(|e| matches!(e, Event::IgateStatus(_, "connected", _, _, _)));
        let new_epoch = h.client.rf_session.load(Ordering::SeqCst);
        assert_ne!(old_epoch, new_epoch);
        h.client
            .commands
            .send(Command::Rf(
                old_epoch,
                Instant::now(),
                Box::new(rf(b"!old-session")),
            ))
            .unwrap();
        h.client
            .commands
            .send(Command::Rf(
                new_epoch,
                Instant::now() - RF_MAX_AGE,
                Box::new(rf(b"!stale")),
            ))
            .unwrap();
        h.client.offer(&[rf(b"!fresh")]);
        assert_eq!(second.line(), b"K9ABC>APTEST,qAO,N0ABC-15:!fresh\r\n");
        h.stop();
        assert!(second.line().is_empty());
        assert_eq!(h.connections.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stopping_igate_during_login_preserves_a_separately_requested_send() {
        let h = Harness::new();
        h.client
            .igate(Some(credentials("N0ABC-15", Some("123"))))
            .unwrap();
        let mut gate = h.accept();
        assert!(gate.line().starts_with(b"user N0ABC-15 pass 123 "));
        let (reply, result) = mpsc::channel();
        h.client
            .commands
            .send(Command::Send(
                credentials("N0ABC-1", Some("123")),
                "!requested".into(),
                Instant::now() + SEND_TIMEOUT,
                reply,
            ))
            .unwrap();
        h.client.igate(None).unwrap();
        assert!(gate.line().is_empty());
        let mut sender = h.accept();
        sender.login("N0ABC-1", "123", true);
        assert_eq!(sender.line(), b"N0ABC-1>APOBCN,TCPIP*:!requested\r\n");
        result
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        h.stop();
    }

    #[test]
    fn a_failed_login_connection_cancels_pending_sends_without_replay() {
        let h = Harness::new();
        let failed = spawn_send(&h.client, "N0ABC-1", "!do-not-replay");
        let mut first = h.accept();
        assert!(first.line().starts_with(b"user N0ABC-1 pass 123 "));
        first.0.get_mut().shutdown(Shutdown::Both).unwrap();
        assert!(failed.join().unwrap().is_err());
        let mut next = h.accept();
        next.login("N0ABC-1", "123", true);
        let fresh = spawn_send(&h.client, "N0ABC-1", "!fresh-request");
        assert_eq!(next.line(), b"N0ABC-1>APOBCN,TCPIP*:!fresh-request\r\n");
        fresh.join().unwrap().unwrap();
        h.stop();
        assert!(next.line().is_empty());
        assert_eq!(h.connections.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn standalone_sends_reuse_one_session_and_expired_sends_do_not_transmit() {
        let h = Harness::new();
        let send = spawn_send(&h.client, "N0ABC-1", "!first");
        let mut peer = h.accept();
        peer.login("N0ABC-1", "123", true);
        assert_eq!(peer.line(), b"N0ABC-1>APOBCN,TCPIP*:!first\r\n");
        send.join().unwrap().unwrap();
        let (reply, result) = mpsc::channel();
        h.client
            .commands
            .send(Command::Send(
                credentials("N0ABC-1", Some("123")),
                "!expired".into(),
                Instant::now() - Duration::from_secs(1),
                reply,
            ))
            .unwrap();
        assert!(result
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .is_err());
        let send = spawn_send(&h.client, "N0ABC-13", "_next");
        assert_eq!(peer.line(), b"N0ABC-13>APOBCN,TCPIP*:_next\r\n");
        send.join().unwrap().unwrap();
        assert_eq!(h.connections.load(Ordering::SeqCst), 1);
        h.stop();
        assert!(peer.line().is_empty());
    }
}
