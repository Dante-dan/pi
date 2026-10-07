//! Unix keyed exec. The lock is inherited by a detached shim before the starter releases it, so a second
//! connection cannot mistake the launch gap for a never-started job. A durable start marker makes ambiguous
//! launches fail as lost rather than executing a possibly non-idempotent command twice.

use crate::errors::Failure;
use crate::exec::{self, Control, ExecRequest};
use crate::frame::{self, Frame};
use crate::output::Output;
use crate::window::Window;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const DEFAULT_LEASE_MS: u64 = 60 * 60 * 1000;
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
static TEMPORARIES: AtomicU64 = AtomicU64::new(0);

fn io_failure(error: io::Error) -> Failure {
    Failure::new("unknown", format!("keyed exec store: {error}"))
}

fn read_json(path: &Path) -> io::Result<Value> {
    serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)
}

fn write_json(path: &Path, value: &Value) -> io::Result<()> {
    let temporary = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        TEMPORARIES.fetch_add(1, Ordering::Relaxed)
    ));
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    serde_json::to_writer(&file, value).map_err(io::Error::other)?;
    // Reboot loses the shim and is reported as lost. Live cursors and leases need atomic visibility,
    // while claim and terminal records need a disk barrier.
    let durable = !matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("lease.json" | "checkpoint.json" | ".cleanup.json")
    );
    if durable {
        file.sync_all()?;
    }
    fs::rename(temporary, path)?;
    if durable {
        File::open(path.parent().unwrap())?.sync_all()?;
    }
    Ok(())
}

fn lock(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
}

fn try_lock(file: &File) -> io::Result<bool> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(false)
    } else {
        Err(error)
    }
}

fn directory(key: &str) -> io::Result<(PathBuf, File)> {
    let root = PathBuf::from(crate::sys::home()).join(".pi/env/jobs");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)?;
    // Cleanup is opportunistic and serialized. A recently attached terminal job is retained too.
    let collector = lock(&root.join(".cleanup.lock"))?;
    if try_lock(&collector)? {
        let last = read_json(&root.join(".cleanup.json"))
            .ok()
            .and_then(|value| value["at"].as_u64())
            .unwrap_or(0);
        if crate::now_ms().saturating_sub(last) >= 60 * 60 * 1000 {
            for entry in fs::read_dir(&root)? {
                let path = entry?.path();
                if !path.is_dir() || !path.join("status.json").exists() {
                    continue;
                }
                let renewed = read_json(&path.join("lease.json"))
                    .ok()
                    .and_then(|value| value["renewed"].as_u64())
                    .unwrap_or(crate::now_ms());
                if crate::now_ms().saturating_sub(renewed) <= RETENTION_MS {
                    continue;
                }
                let guard = lock(&path.join("lock"))?;
                if try_lock(&guard)? {
                    fs::remove_dir_all(path)?;
                }
            }
            write_json(&root.join(".cleanup.json"), &json!({"at":crate::now_ms()}))?;
        }
    }
    // Every attachment holds a shared collection lock. Collection only runs when no job is being attached;
    // it cannot remove an old terminal job between specification comparison and output delivery.
    if unsafe { libc::flock(collector.as_raw_fd(), libc::LOCK_SH) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let digest = Sha256::digest(key.as_bytes());
    let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory = root.join(name);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .or_else(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                Ok(())
            } else {
                Err(error)
            }
        })?;
    // Persist the job entry and any newly created .pi/env/jobs ancestors before publishing a start marker.
    for parent in root.ancestors().take(4) {
        File::open(parent)?.sync_all()?;
    }
    Ok((directory, collector))
}

fn renew(directory: &Path) -> io::Result<()> {
    write_json(
        &directory.join("lease.json"),
        &json!({ "renewed": crate::now_ms() }),
    )
}

fn start(directory: &Path, guard: &File) -> io::Result<()> {
    // Persist intent before spawning. A crash here is conservative `lost`, never a second execution.
    write_json(
        &directory.join("started.json"),
        &json!({ "started": crate::now_ms() }),
    )?;
    let descriptor = guard.as_raw_fd();
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("shim")
        .arg(directory)
        .arg(descriptor.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
            if libc::fcntl(descriptor, libc::F_SETFD, 0) < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn run(
    id: u32,
    request: &Value,
    output: &Arc<Output>,
    control: &Control,
) -> Result<Value, Failure> {
    if control.aborted.load(Ordering::SeqCst) {
        return Err(Failure::new("aborted", "aborted"));
    }
    let key = request["key"]
        .as_str()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| Failure::new("EINVAL", "key must be a nonempty string"))?;
    let valid = ["maxBytes", "maxLines"].iter().all(|field| {
        request["window"][field]
            .as_u64()
            .is_some_and(|value| value < frame::MAX_FRAME as u64)
    }) && request["window"]["minIntervalMs"]
        .as_f64()
        .is_some_and(|value| value.is_finite() && (0.0..=2_147_483_647.0).contains(&value))
        && request["window"]["bytesPerSecond"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0);
    if !valid {
        return Err(Failure::new("EINVAL", "invalid keyed exec output window"));
    }
    if request.get("timeoutMs").is_some_and(|value| {
        !value
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0 && value <= 2_147_483_647.0)
    }) {
        return Err(Failure::new("EINVAL", "invalid keyed exec timeout"));
    }
    if request.get("offset").is_some_and(|offset| {
        ["log", "bytes", "newlines"]
            .iter()
            .any(|field| offset[field].as_u64().is_none())
    }) {
        return Err(Failure::new("EINVAL", "invalid keyed exec output offset"));
    }
    Window::from_json(&request["window"])
        .ok_or_else(|| Failure::new("EINVAL", "keyed exec requires window"))?;
    let lease = match request.get("leaseMs") {
        Some(value) => value
            .as_u64()
            .ok_or_else(|| Failure::new("EINVAL", "leaseMs must be a positive integer"))?,
        None => DEFAULT_LEASE_MS,
    };
    if lease == 0 {
        return Err(Failure::new("EINVAL", "leaseMs must be positive"));
    }
    ExecRequest::from_json(request)?;
    let (directory, _collection_guard) = directory(key).map_err(io_failure)?;
    // Presence is held by the serving process, not inherited by the shim. A stalled follower
    // must not expire an attached job; closing the connection releases it with the process.
    let observer = lock(&directory.join("observers")).map_err(io_failure)?;
    if unsafe { libc::flock(observer.as_raw_fd(), libc::LOCK_SH) } < 0 {
        return Err(io_failure(io::Error::last_os_error()));
    }
    let guard = lock(&directory.join("lock")).map_err(io_failure)?;
    let claimed = try_lock(&guard).map_err(io_failure)?;
    let mut spec = request.clone();
    for field in ["op", "key", "offset"] {
        spec.as_object_mut().unwrap().remove(field);
    }
    spec["leaseMs"] = json!(lease);
    spec["storeVersion"] = json!(1);
    let path = directory.join("spec.json");
    if !path.exists() && !claimed {
        // The first claimant has the lock but has not published the specification yet.
        while !path.exists() {
            if control.aborted.load(Ordering::SeqCst) {
                return Err(Failure::new("aborted", "aborted"));
            }
            if try_lock(&guard).map_err(io_failure)? {
                return Err(Failure::new(
                    "lost",
                    "keyed exec starter died before publishing its specification",
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    if path.exists() {
        if read_json(&path).map_err(io_failure)? != spec {
            return Err(Failure::new(
                "EINVAL",
                "different exec specification for the same key",
            ));
        }
    } else {
        write_json(&path, &spec).map_err(io_failure)?;
    }
    if claimed && !directory.join("status.json").exists() {
        if directory.join("started.json").exists() {
            return Err(Failure::new(
                "lost",
                "keyed exec shim died; command may have partially run",
            ));
        }
        renew(&directory).map_err(io_failure)?;
        start(&directory, &guard).map_err(io_failure)?;
    }
    // Drop without LOCK_UN: the shim inherited the same open file description and keeps the lock.
    drop(guard);
    follow(id, &directory, &request["offset"], output, control)
}

fn follow(
    id: u32,
    directory: &Path,
    resume: &Value,
    output: &Arc<Output>,
    control: &Control,
) -> Result<Value, Failure> {
    let spec = read_json(&directory.join("spec.json")).map_err(io_failure)?;
    let window = Window::from_json(&spec["window"]).unwrap();
    let mut cursor = if resume.is_null() {
        json!({"log":0,"bytes":0,"newlines":0})
    } else {
        resume.clone()
    };
    for field in ["log", "bytes", "newlines"] {
        if cursor[field].as_u64().is_none() {
            return Err(Failure::new("EINVAL", "invalid keyed exec output offset"));
        }
    }
    let mut renewed = 0;
    let mut delivered = std::time::Instant::now();
    let unsent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let guard = lock(&directory.join("lock")).map_err(io_failure)?;
    loop {
        let interval = (spec["leaseMs"].as_u64().unwrap() / 3).clamp(1, 1000);
        if crate::now_ms().saturating_sub(renewed) >= interval {
            renew(directory).map_err(io_failure)?;
            renewed = crate::now_ms();
        }
        if control.aborted.load(Ordering::SeqCst) || control.killed.load(Ordering::SeqCst) {
            write_json(
                &directory.join("cancel.json"),
                &json!({ "kill": control.killed.load(Ordering::SeqCst) }),
            )
            .map_err(io_failure)?;
        }
        let status = directory.join("status.json");
        let finished = status.exists();
        if unsent.load(Ordering::SeqCst) == 0
            && (finished || std::time::Instant::now() >= delivered)
            && directory.join("checkpoint.json").exists()
        {
            let checkpoint = read_json(&directory.join("checkpoint.json")).map_err(io_failure)?;
            let mut bytes = 0;
            for event in checkpoint["events"].as_array().unwrap() {
                let next = &event["json"]["offset"];
                if next["log"].as_u64().unwrap() <= cursor["log"].as_u64().unwrap() {
                    continue;
                }
                let text = event["text"].as_str().unwrap();
                let mut header = event["json"].clone();
                let before = next["bytes"].as_u64().unwrap() - text.len() as u64;
                let before_lines = next["newlines"].as_u64().unwrap()
                    - text.bytes().filter(|byte| *byte == b'\n').count() as u64;
                if before > cursor["bytes"].as_u64().unwrap() {
                    header["skipped"] = json!({ "bytes": before - cursor["bytes"].as_u64().unwrap(), "newlines": before_lines.saturating_sub(cursor["newlines"].as_u64().unwrap()), "endsWithNewline": checkpoint["endsWithNewline"] });
                }
                cursor = next.clone();
                bytes += text.len();
                output.bulk(
                    Frame::with_payload(frame::EVENT, id, header, text.as_bytes().to_vec()),
                    Some(unsent.clone()),
                );
            }
            delivered = std::time::Instant::now()
                + window.min_interval.max(Duration::from_secs_f64(
                    bytes.min(window.max_bytes) as f64 / window.bytes_per_second,
                ));
        }
        if status.exists() {
            let stored_status = read_json(&status).map_err(io_failure)?;
            let length = stored_status["outputOffset"].as_u64().unwrap_or(0);
            if cursor["log"].as_u64().unwrap() < length {
                continue;
            }
            if unsent.load(Ordering::SeqCst) > 0 {
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            if let Some(failure) = stored_status.get("error") {
                return Err(Failure::new(
                    failure["code"].as_str().unwrap_or("unknown"),
                    failure["message"].as_str().unwrap_or("keyed exec failed"),
                )
                .extra(failure.clone()));
            }
            return Ok(stored_status["result"].clone());
        }
        if try_lock(&guard).map_err(io_failure)? {
            if status.exists() {
                continue;
            }
            return Err(Failure::new(
                "lost",
                "keyed exec shim died; command may have partially run",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// Runs in a new session with the launcher's inherited lock. Keyless execution remains connection-owned.
pub fn shim(directory: &Path, descriptor: i32) -> io::Result<()> {
    let guard = unsafe { File::from_raw_fd(descriptor) };
    if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    write_json(
        &directory.join("pid.json"),
        &json!({ "pid": std::process::id() }),
    )?;
    let spec = read_json(&directory.join("spec.json"))?;
    let mut request =
        ExecRequest::from_json(&spec).map_err(|failure| io::Error::other(failure.message))?;
    if let Some(timeout) = request.timeout {
        let started = read_json(&directory.join("started.json"))?["started"]
            .as_u64()
            .unwrap();
        let elapsed = Duration::from_millis(crate::now_ms().saturating_sub(started));
        if elapsed >= timeout {
            write_json(
                &directory.join("status.json"),
                &json!({"error":{"code":"timeout","message":"timeout"}}),
            )?;
            return Ok(());
        }
        request.timeout = Some(timeout - elapsed);
    }
    let window = request.window.take().unwrap();
    request.spill = Some((0, 0));
    let output = Arc::new(Output::default());
    let control = Arc::new(Control::default());
    let finished = Arc::new(AtomicBool::new(false));
    let monitor = {
        let directory = directory.to_owned();
        let control = control.clone();
        let finished = finished.clone();
        let lease = spec["leaseMs"].as_u64().unwrap();
        thread::spawn(move || {
            let observer = match lock(&directory.join("observers")) {
                Ok(observer) => observer,
                Err(_) => {
                    control.cancel(false);
                    return;
                }
            };
            while !finished.load(Ordering::SeqCst) {
                if let Ok(cancel) = read_json(&directory.join("cancel.json")) {
                    control.cancel(cancel["kill"].as_bool().unwrap_or(false));
                }
                let renewed = read_json(&directory.join("lease.json"))
                    .ok()
                    .and_then(|value| value["renewed"].as_u64())
                    .unwrap_or(0);
                match try_lock(&observer) {
                    Ok(true) => {
                        unsafe {
                            libc::flock(observer.as_raw_fd(), libc::LOCK_UN);
                        }
                        if crate::now_ms().saturating_sub(renewed) >= lease {
                            control.cancel(false);
                        }
                    }
                    Ok(false) => {
                        if renew(&directory).is_err() {
                            control.cancel(false);
                        }
                    }
                    Err(_) => control.cancel(false),
                }
                thread::sleep(Duration::from_millis(20));
            }
        })
    };
    let writer = {
        let output = output.clone();
        let control = control.clone();
        let directory = directory.to_owned();
        thread::spawn(move || -> io::Result<()> {
            let opened = OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .open(directory.join("events.log"));
            let mut log = match opened {
                Ok(log) => log,
                Err(error) => {
                    control.cancel(false);
                    output.close();
                    return Err(error);
                }
            };
            let mut events = VecDeque::<Value>::new();
            let mut total_bytes = 0u64;
            let mut total_lines = 0u64;
            let mut held_bytes = 0usize;
            let mut held_lines = 0usize;
            let mut ends_with_newline = false;
            let mut failure = None;
            output.run_frames(|event| {
                let result = (|| {
                    frame::write_frame(&mut log, event)?;
                    let text = String::from_utf8_lossy(&event.payload);
                    let lines = text.bytes().filter(|byte| *byte == b'\n').count();
                    total_bytes += text.len() as u64;
                    total_lines += lines as u64;
                    held_bytes += text.len();
                    held_lines += lines;
                    let mut header = event.json.clone();
                    header["offset"] = json!({ "log": log.stream_position()?, "bytes": total_bytes, "newlines": total_lines });
                    events.push_back(json!({ "json": header, "text": text }));
                    while events.len() > 1 {
                        let first = events.front().unwrap()["text"].as_str().unwrap();
                        let lines = first.bytes().filter(|byte| *byte == b'\n').count();
                        if held_bytes - first.len() <= window.max_bytes && held_lines - lines <= window.max_lines { break; }
                        held_bytes -= first.len();
                        held_lines -= lines;
                        ends_with_newline = first.ends_with('\n');
                        events.pop_front();
                    }
                    if let Some(first) = events.front_mut() {
                        let text = first["text"].as_str().unwrap();
                        let rest_bytes = held_bytes - text.len();
                        let positions: Vec<usize> = text.bytes().enumerate().filter(|(_, byte)| *byte == b'\n').map(|(index, _)| index).collect();
                        let rest_lines = held_lines - positions.len();
                        let keep_bytes = (window.max_bytes + 1).saturating_sub(rest_bytes);
                        let mut cut = text.len().saturating_sub(keep_bytes);
                        while cut > 0 && !text.is_char_boundary(cut) { cut -= 1; }
                        let keep_lines = (window.max_lines + 1).saturating_sub(rest_lines);
                        if keep_lines == 0 { cut = text.len(); }
                        else if positions.len() >= keep_lines { cut = cut.max(positions[positions.len() - keep_lines]); }
                        if cut > 0 {
                            ends_with_newline = text[..cut].ends_with('\n');
                            held_bytes -= cut;
                            held_lines -= text[..cut].bytes().filter(|byte| *byte == b'\n').count();
                            let tail = text[cut..].to_string();
                            first["text"] = json!(tail);
                        }
                    }
                    write_json(&directory.join("checkpoint.json"), &json!({ "events": events, "endsWithNewline": ends_with_newline }))
                })();
                if let Err(error) = &result {
                    failure = Some(error.to_string());
                    control.cancel(false);
                }
                result
            });
            log.sync_all()?;
            match failure {
                Some(error) => Err(io::Error::other(error)),
                None => Ok(()),
            }
        })
    };
    let groups = Arc::new(Mutex::new(Default::default()));
    let result = exec::run(
        1,
        request,
        &directory.to_string_lossy(),
        &output,
        &control,
        &groups,
    );
    output.close();
    let stored = writer
        .join()
        .map_err(|_| io::Error::other("job output writer panicked"))?;
    finished.store(true, Ordering::SeqCst);
    let _ = monitor.join();
    let mut status = match stored {
        Err(error) => {
            json!({ "error": { "code": "unknown", "message": format!("Failed to preserve complete shell output: {error}") } })
        }
        Ok(()) => match result {
            Ok(result) => json!({ "result": result }),
            Err(failure) => json!({ "error": failure.to_json() }),
        },
    };
    status["outputOffset"] = json!(
        read_json(&directory.join("checkpoint.json"))
            .ok()
            .and_then(|checkpoint| checkpoint["events"]
                .as_array()
                .and_then(|events| events.last())
                .and_then(|event| event["json"]["offset"]["log"].as_u64()))
            .unwrap_or(0)
    );
    let synced = (|| -> io::Result<()> {
        let checkpoint = directory.join("checkpoint.json");
        if checkpoint.exists() {
            File::open(checkpoint)?.sync_all()?;
        }
        let spill = status["result"]["spillPath"]
            .as_str()
            .or_else(|| status["error"]["spillPath"].as_str());
        if let Some(spill) = spill {
            File::open(spill)?.sync_all()?;
            File::open(Path::new(spill).parent().unwrap())?.sync_all()?;
        }
        Ok(())
    })();
    if let Err(error) = synced {
        status["error"] = json!({"code":"unknown","message":format!("Failed to persist complete shell output: {error}")});
        status.as_object_mut().unwrap().remove("result");
    }
    write_json(&directory.join("status.json"), &status)?;
    drop(guard);
    Ok(())
}
