//! Local event listener for the Kibo reporter (`scripts/kibo-report.mjs`).
//!
//! Security model:
//!   * binds to 127.0.0.1 only (never a public interface), on an OS-chosen port, no admin rights;
//!   * every message must carry a random per-launch token that is stored in a file inside the
//!     user's private app-data directory (`ipc.json`), so only processes that can read that file
//!     can inject events;
//!   * one line per connection, at most `MAX_LINE` bytes, strict whitelist parsing;
//!   * only a validated, canonical JSON string is forwarded to the UI (event type, optional
//!     duration, optional source label). No arbitrary text is ever relayed;
//!   * a failure to start the listener never affects the rest of the app.
//!
//! Wire format (one line, space separated):
//!   KIBO/1 <token> <event> [duration=<ms>] [source=<label>]
use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// Tauri event the UI listens to. Payload: validated JSON string.
pub const DEV_EVENT: &str = "kibo:dev-event";
pub const DISCOVERY_FILE: &str = "ipc.json";

const MAX_LINE: u64 = 512;
const MAX_CONNECTIONS: usize = 8;
const IO_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_DURATION_MS: u64 = 86_400_000;
const MAX_SOURCE_LEN: usize = 32;
const EVENTS: [&str; 7] = [
    "build_started",
    "build_succeeded",
    "build_failed",
    "task_completed",
    "user_returned",
    "system_idle",
    "system_active",
];

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Validates one protocol line and returns the canonical JSON to forward, or a short error code.
pub fn parse_line(line: &str, token: &str) -> Result<String, &'static str> {
    let mut parts = line.split_whitespace();
    if parts.next() != Some("KIBO/1") {
        return Err("bad-protocol");
    }
    let given = parts.next().ok_or("missing-token")?;
    if !ct_eq(given.as_bytes(), token.as_bytes()) {
        return Err("unauthorized");
    }
    let event = parts.next().ok_or("missing-event")?;
    if !EVENTS.contains(&event) {
        return Err("unknown-event");
    }
    let mut duration: Option<u64> = None;
    let mut source: Option<&str> = None;
    for field in parts {
        let (key, value) = field.split_once('=').ok_or("bad-field")?;
        match key {
            "duration" => {
                let d: u64 = value.parse().map_err(|_| "bad-duration")?;
                if d > MAX_DURATION_MS {
                    return Err("bad-duration");
                }
                duration = Some(d);
            }
            "source" => {
                let ok = !value.is_empty()
                    && value.len() <= MAX_SOURCE_LEN
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
                if !ok {
                    return Err("bad-source");
                }
                source = Some(value);
            }
            _ => return Err("bad-field"),
        }
    }
    // Every interpolated piece is whitelisted above (no quotes, backslashes or control chars).
    let mut json = format!("{{\"type\":\"{}\"", event);
    if let Some(d) = duration {
        json.push_str(&format!(",\"durationMs\":{}", d));
    }
    if let Some(s) = source {
        json.push_str(&format!(",\"source\":\"{}\"", s));
    }
    json.push('}');
    Ok(json)
}

/// 256 random bits as hex. `RandomState` is seeded from the OS RNG; no extra crate needed.
fn random_token() -> String {
    let mut out = String::with_capacity(64);
    for i in 0..4u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn write_discovery(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    let body = format!("{{\"v\":1,\"port\":{},\"token\":\"{}\"}}\n", port, token);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(body.as_bytes())
}

struct Slot(Arc<AtomicUsize>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn handle_connection(mut stream: TcpStream, token: &str, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut line = String::new();
    let result = {
        let mut reader = BufReader::new((&stream).take(MAX_LINE));
        match reader.read_line(&mut line) {
            Ok(0) => Err("empty"),
            Ok(_) if !line.ends_with('\n') => Err("unterminated-or-too-long"),
            Ok(_) => parse_line(line.trim_end(), token),
            Err(_) => Err("read-error"),
        }
    };
    match result {
        Ok(json) => {
            let _ = app.emit(DEV_EVENT, json);
            let _ = stream.write_all(b"ok\n");
        }
        Err(code) => {
            let _ = stream.write_all(format!("err {}\n", code).as_bytes());
        }
    }
}

/// Starts the listener thread and publishes port + token in `<dir>/ipc.json`.
/// Returns an error instead of panicking; the caller just logs it and carries on.
pub fn start(app: &AppHandle, dir: PathBuf) -> std::io::Result<()> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    fs::create_dir_all(&dir)?;
    write_discovery(&dir.join(DISCOVERY_FILE), port, &token)?;

    let app = app.clone();
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("kibo-ipc".into())
        .spawn(move || {
            for conn in listener.incoming() {
                let stream = match conn {
                    Ok(s) => s,
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(50));
                        continue;
                    }
                };
                let local_peer = stream.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false);
                if !local_peer {
                    continue;
                }
                if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    active.fetch_sub(1, Ordering::SeqCst);
                    let mut s = stream;
                    let _ = s.write_all(b"err busy\n");
                    continue;
                }
                let slot = Slot(Arc::clone(&active));
                let (app, token) = (app.clone(), token.clone());
                let spawned = std::thread::Builder::new().name("kibo-ipc-conn".into()).spawn(move || {
                    let _slot = slot;
                    handle_connection(stream, &token, &app);
                });
                if spawned.is_err() {
                    // `slot` was moved into the failed closure and dropped with it.
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        })?;
    Ok(())
}

/// Best effort: remove the discovery file so a stale port/token is not left behind.
pub fn cleanup(dir: &Path) {
    let _ = fs::remove_file(dir.join(DISCOVERY_FILE));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_lines() {
        assert_eq!(parse_line("KIBO/1 tok build_failed", "tok").unwrap(), "{\"type\":\"build_failed\"}");
        assert_eq!(
            parse_line("KIBO/1 tok build_succeeded duration=1200 source=cargo", "tok").unwrap(),
            "{\"type\":\"build_succeeded\",\"durationMs\":1200,\"source\":\"cargo\"}"
        );
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(parse_line("", "tok"), Err("bad-protocol"));
        assert_eq!(parse_line("HTTP/1.1 GET /", "tok"), Err("bad-protocol"));
        assert_eq!(parse_line("KIBO/1 nope build_failed", "tok"), Err("unauthorized"));
        assert_eq!(parse_line("KIBO/1", "tok"), Err("missing-token"));
        assert_eq!(parse_line("KIBO/1 tok", "tok"), Err("missing-event"));
        assert_eq!(parse_line("KIBO/1 tok rm_rf", "tok"), Err("unknown-event"));
        assert_eq!(parse_line("KIBO/1 tok build_failed duration=-1", "tok"), Err("bad-duration"));
        assert_eq!(parse_line("KIBO/1 tok build_failed duration=99999999999", "tok"), Err("bad-duration"));
        assert_eq!(parse_line("KIBO/1 tok build_failed source=a\"b", "tok"), Err("bad-source"));
        assert_eq!(parse_line("KIBO/1 tok build_failed source=../x", "tok"), Err("bad-source"));
        assert_eq!(parse_line("KIBO/1 tok build_failed cmd=ls", "tok"), Err("bad-field"));
        assert_eq!(parse_line("KIBO/1 tok build_failed junk", "tok"), Err("bad-field"));
    }

    #[test]
    fn tokens_are_unique_and_long() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
