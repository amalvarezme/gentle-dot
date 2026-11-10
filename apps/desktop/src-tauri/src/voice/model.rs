//! The optional local voice model (S30.5): NVIDIA Parakeet TDT 0.6B v3, int8, in the sherpa-onnx
//! export. Nothing downloads unless the user asks. The four model files come one by one from the
//! Hugging Face repository `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` at a pinned
//! commit, the same immutable source Gentle Shell's voice uses; each file's size and SHA-256 are
//! pinned here. A download streams every file into a staging directory next to the install,
//! hashing it on the way, and fails on the first file that does not match. The verified files
//! then move into place with one rename, so a model directory is either complete or absent;
//! failures and cancels remove the staging directory. An install records the commit it came from
//! in `<dir>/.source` (installs from the earlier GitHub archive have none and still work).
//!
//! Progress and outcomes go out as `voice://model` events, throttled to a few a second.

use crate::computer::Clock;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

/// `{state, received?, total?, message?}`, to the panel.
pub const MODEL_EVENT: &str = "voice://model";
/// At most one progress event per this many milliseconds (plus the last one).
pub const PROGRESS_INTERVAL_MS: u64 = 250;
/// The file in an install that names the source revision it was downloaded from.
pub const SOURCE_MARKER: &str = ".source";
const CHUNK: usize = 64 * 1024;
const CANCELLED: &str = "The download was cancelled.";

/// One file of the model, as published at the pinned revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelFile {
    pub name: String,
    /// The file's size in bytes.
    pub size: u64,
    /// Lowercase hex SHA-256 of the file.
    pub sha256: String,
}

impl ModelFile {
    fn new(name: &str, size: u64, sha256: &str) -> Self {
        ModelFile { name: name.into(), size, sha256: sha256.into() }
    }
}

/// What to download and what it must contain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSpec {
    /// Each file is at `{base_url}/{name}`.
    pub base_url: String,
    /// The pinned source revision, written to `<dir>/.source` after an install.
    pub revision: String,
    /// The install directory under the models directory.
    pub dir: String,
    /// The files the recognizer needs, all of them required, downloaded in this order.
    pub files: Vec<ModelFile>,
}

impl ModelSpec {
    /// The sherpa-onnx export on Hugging Face at a fixed commit, so the bytes never change under
    /// the pin. Hugging Face redirects each file (same-origin for `tokens.txt`, to its HTTPS CDN
    /// for the large ones); the redirects are followed. Sizes and digests match Gentle Shell's
    /// voice artifacts for the same revision.
    pub fn parakeet() -> Self {
        let repo = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
        let revision = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
        ModelSpec {
            base_url: format!("https://huggingface.co/{repo}/resolve/{revision}"),
            revision: revision.into(),
            dir: "parakeet-tdt-0.6b-v3-int8".into(),
            files: vec![
                ModelFile::new("encoder.int8.onnx", 652_184_281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
                ModelFile::new("decoder.int8.onnx", 11_845_275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
                ModelFile::new("joiner.int8.onnx", 6_355_277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
                ModelFile::new("tokens.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
            ],
        }
    }

    /// The download size, every file together (also the installed size).
    pub fn total(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }

    /// Where one file is fetched from.
    pub fn url(&self, file: &ModelFile) -> String {
        format!("{}/{}", self.base_url.trim_end_matches('/'), file.name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelState {
    Downloading,
    /// Every file arrived and matched its checksum; moving the model into place.
    Verifying,
    Installed,
    /// Failed or cancelled; `message` says which.
    Failed,
    Removed,
    /// The installed model was turned on or off (`voice_model_set_enabled`).
    Switched,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelEvent {
    pub state: ModelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ModelEvent {
    pub fn state(state: ModelState) -> Self {
        ModelEvent { state, received: None, total: None, message: None }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        ModelEvent { message: Some(message.into()), ..ModelEvent::state(ModelState::Failed) }
    }

    fn progress(received: u64, total: u64) -> Self {
        ModelEvent { received: Some(received), total: Some(total), ..ModelEvent::state(ModelState::Downloading) }
    }
}

/// The speech-to-text engine `voice_start` uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineName {
    Parakeet,
    Apple,
    None,
}

/// The `voice_model_status` reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelStatus {
    pub installed: bool,
    /// The installed files' total size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    pub downloading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Whether an installed model is used; off keeps its files and listens with the fallback.
    pub enabled: bool,
    pub engine: EngineName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    Installed,
    Downloading,
    Failed(String),
}

impl fmt::Display for ModelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ModelError::Installed => f.write_str("The local voice model is already installed."),
            ModelError::Downloading => f.write_str("The local voice model is downloading. Cancel the download first."),
            ModelError::Failed(message) => f.write_str(message),
        }
    }
}

impl From<ModelError> for String {
    fn from(error: ModelError) -> String {
        error.to_string()
    }
}

/// An open download: the body, and its length when the server says.
pub struct Download {
    pub body: Box<dyn Read + Send>,
    pub length: Option<u64>,
}

/// Opens a URL for reading. HTTPS in the app, in-memory files in tests.
pub trait Fetcher: Send + Sync {
    fn open(&self, url: &str) -> Result<Download, String>;
}

/// HTTPS through ureq (rustls with the bundled web PKI roots; `HTTPS_PROXY` is honored). Hugging
/// Face answers each file URL with a redirect (307 to a same-origin cache path, or 302 to its
/// HTTPS CDN); ureq follows up to five, and `https_only` refuses any hop to plain HTTP.
pub struct HttpFetcher;

impl Fetcher for HttpFetcher {
    fn open(&self, url: &str) -> Result<Download, String> {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(20))
            .timeout_read(Duration::from_secs(60))
            .try_proxy_from_env(true)
            .https_only(true)
            .build();
        let response = agent.get(url).call().map_err(|error| error.to_string())?;
        let length = response.header("Content-Length").and_then(|value| value.parse().ok());
        Ok(Download { body: Box::new(response.into_reader()), length })
    }
}

pub type ModelEvents = Arc<dyn Fn(ModelEvent) + Send + Sync>;

/// Downloads, verifies, installs, and removes one model under a models directory.
pub struct ModelManager {
    shared: Arc<Shared>,
}

struct Shared {
    spec: ModelSpec,
    root: PathBuf,
    fetcher: Arc<dyn Fetcher>,
    clock: Arc<dyn Clock>,
    events: ModelEvents,
    /// The engine used while the model is absent.
    fallback: EngineName,
    job: Mutex<Option<Job>>,
}

/// The download in flight.
struct Job {
    cancel: Arc<AtomicBool>,
    received: u64,
    total: u64,
}

enum Failure {
    Cancelled,
    Error(String),
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Failure::Error(format!("The local voice model could not be installed: {error}"))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Removes a directory this manager owns, if present.
fn clear(path: &Path) -> io::Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

impl ModelManager {
    pub fn new(
        spec: ModelSpec,
        root: PathBuf,
        fetcher: Arc<dyn Fetcher>,
        clock: Arc<dyn Clock>,
        events: ModelEvents,
        fallback: EngineName,
    ) -> Self {
        let shared = Shared { spec, root, fetcher, clock, events, fallback, job: Mutex::new(None) };
        ModelManager { shared: Arc::new(shared) }
    }

    /// The model directory, when every model file is in it.
    pub fn installed(&self) -> Option<PathBuf> {
        self.shared.installed()
    }

    /// The model directory the recognizer uses: installed and not turned off.
    pub fn active(&self) -> Option<PathBuf> {
        self.shared.enabled().then(|| self.installed()).flatten()
    }

    /// Turns the installed model on or off, kept across restarts; a `switched` event follows.
    pub fn set_enabled(&self, enabled: bool) -> Result<(), ModelError> {
        let marker = self.shared.off_marker();
        let saved = if enabled {
            match fs::remove_file(&marker) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            }
        } else {
            fs::create_dir_all(&self.shared.root).and_then(|()| fs::write(&marker, b""))
        };
        saved.map_err(|error| ModelError::Failed(format!("The voice setting could not be saved: {error}")))?;
        (self.shared.events)(ModelEvent::state(ModelState::Switched));
        Ok(())
    }

    pub fn status(&self) -> ModelStatus {
        let (downloading, received, total) = match &*lock(&self.shared.job) {
            Some(job) => (true, Some(job.received), Some(job.total)),
            None => (false, None, None),
        };
        let dir = self.installed();
        let bytes = dir.as_ref().map(|dir| self.shared.spec.files.iter().filter_map(|f| fs::metadata(dir.join(&f.name)).ok()).map(|m| m.len()).sum());
        let enabled = self.shared.enabled();
        let engine = if dir.is_some() && enabled { EngineName::Parakeet } else { self.shared.fallback };
        ModelStatus { installed: dir.is_some(), bytes, downloading, received, total, enabled, engine }
    }

    /// Starts the download in the background; progress and the outcome arrive as events.
    pub fn download(&self) -> Result<(), ModelError> {
        let mut job = lock(&self.shared.job);
        if job.is_some() {
            return Err(ModelError::Downloading);
        }
        if self.installed().is_some() {
            return Err(ModelError::Installed);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let shared = self.shared.clone();
        let flag = cancel.clone();
        std::thread::Builder::new()
            .name("voice-model-download".into())
            .spawn(move || shared.run(&flag))
            .map_err(|error| ModelError::Failed(format!("The download could not start: {error}")))?;
        *job = Some(Job { cancel, received: 0, total: self.shared.spec.total() });
        Ok(())
    }

    /// Asks the download in flight to stop; whether there was one. The outcome arrives as a
    /// `failed` event once the staging files are gone.
    pub fn cancel(&self) -> bool {
        lock(&self.shared.job).as_ref().map(|job| job.cancel.store(true, Ordering::SeqCst)).is_some()
    }

    /// Deletes the installed model (refused while downloading). Removing nothing is not an error.
    pub fn remove(&self) -> Result<(), ModelError> {
        let shared = &self.shared;
        {
            let job = lock(&shared.job);
            if job.is_some() {
                return Err(ModelError::Downloading);
            }
            let dir = shared.dir();
            // A removed model starts over: the next download is used right away.
            let _ = fs::remove_file(shared.off_marker());
            if fs::symlink_metadata(&dir).is_err() {
                return Ok(());
            }
            // Out of sight in one step, then deleted.
            let trash = shared.root.join(format!(".{}.removing", shared.spec.dir));
            let removed = clear(&trash).and_then(|()| fs::rename(&dir, &trash)).and_then(|()| clear(&trash));
            removed.map_err(|error| ModelError::Failed(format!("The local voice model could not be removed: {error}")))?;
        }
        (shared.events)(ModelEvent::state(ModelState::Removed));
        Ok(())
    }
}

impl Shared {
    fn dir(&self) -> PathBuf {
        self.root.join(&self.spec.dir)
    }

    /// Present while the user has turned the installed model off.
    fn off_marker(&self) -> PathBuf {
        self.root.join(format!(".{}.off", self.spec.dir))
    }

    fn enabled(&self) -> bool {
        fs::symlink_metadata(self.off_marker()).is_err()
    }

    fn staging(&self) -> PathBuf {
        self.root.join(format!(".{}.download", self.spec.dir))
    }

    fn installed(&self) -> Option<PathBuf> {
        let dir = self.dir();
        self.spec.files.iter().all(|file| fs::metadata(dir.join(&file.name)).is_ok_and(|m| m.is_file())).then_some(dir)
    }

    /// The download thread: run, clean up, clear the job, then report.
    fn run(&self, cancel: &AtomicBool) {
        let staging = self.staging();
        let outcome = self.install(&staging, cancel);
        if let Err(error) = clear(&staging) {
            eprintln!("gentle-dot: cannot remove {}: {error}", staging.display());
        }
        *lock(&self.job) = None;
        (self.events)(match outcome {
            Ok(()) => ModelEvent::state(ModelState::Installed),
            Err(Failure::Cancelled) => ModelEvent::failed(CANCELLED),
            Err(Failure::Error(message)) => ModelEvent::failed(message),
        });
    }

    fn install(&self, staging: &Path, cancel: &AtomicBool) -> Result<(), Failure> {
        // A staging directory left by a crash is ours to clear.
        clear(staging)?;
        let model = staging.join("model");
        fs::create_dir_all(&model)?;
        let mut progress = Progress { received: 0, reported: 0, total: self.spec.total(), last_ms: self.clock.now_ms() };
        (self.events)(ModelEvent::progress(0, progress.total));
        for file in &self.spec.files {
            self.fetch(file, &model.join(&file.name), &mut progress, cancel)?;
        }
        if progress.reported != progress.received {
            (self.events)(ModelEvent::progress(progress.received, progress.total));
        }
        (self.events)(ModelEvent::state(ModelState::Verifying));
        fs::write(model.join(SOURCE_MARKER), self.spec.revision.as_bytes())?;
        let dir = self.dir();
        // An incomplete directory (not `installed`) is replaced.
        clear(&dir)?;
        fs::rename(&model, &dir)?;
        Ok(())
    }

    /// Streams one file to `path`, reporting progress across the whole download, and checks its
    /// size and SHA-256 against the pin before going on to the next file.
    fn fetch(&self, spec: &ModelFile, path: &Path, progress: &mut Progress, cancel: &AtomicBool) -> Result<(), Failure> {
        let name = spec.name.as_str();
        let Download { mut body, length } = self
            .fetcher
            .open(&self.spec.url(spec))
            .map_err(|error| Failure::Error(format!("The local voice model could not be downloaded ({name}): {error}")))?;
        let wrong_size = || Failure::Error(format!("The download of {name} was not the expected size."));
        if length.is_some_and(|length| length != spec.size) {
            return Err(wrong_size());
        }
        let mut file = File::create_new(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; CHUNK];
        let mut received = 0u64;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(Failure::Cancelled);
            }
            let read = match body.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(Failure::Error(format!("The download of {name} was interrupted: {error}"))),
            };
            received += read as u64;
            if received > spec.size {
                return Err(wrong_size());
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read])?;
            progress.received += read as u64;
            if let Some(job) = lock(&self.job).as_mut() {
                job.received = progress.received;
            }
            let now = self.clock.now_ms();
            if now.saturating_sub(progress.last_ms) >= PROGRESS_INTERVAL_MS {
                progress.last_ms = now;
                progress.reported = progress.received;
                (self.events)(ModelEvent::progress(progress.received, progress.total));
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(Failure::Cancelled);
        }
        if received != spec.size {
            return Err(wrong_size());
        }
        if hex(&hasher.finalize()) != spec.sha256 {
            return Err(Failure::Error(format!("The download of {name} did not match the published checksum.")));
        }
        file.sync_all()?;
        Ok(())
    }
}

/// Bytes received across every file of one download, and when progress last went out.
struct Progress {
    received: u64,
    reported: u64,
    total: u64,
    last_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::fake::FakeClock;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::io::{Cursor, Read};
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    const FILES: [&str; 4] = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
    const BASE: &str = "https://example.invalid/repo/resolve/test-revision";

    /// Bytes with no pattern, so the encoder spans many reads.
    fn noise(len: usize) -> Vec<u8> {
        let mut state = 0x2545_f491u32;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect()
    }

    /// The four model files a fake server publishes, in download order.
    fn bodies() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("encoder.int8.onnx", noise(20_000)),
            ("decoder.int8.onnx", vec![2u8; 200]),
            ("joiner.int8.onnx", vec![3u8; 100]),
            ("tokens.txt", b"<blk> 0\n".to_vec()),
        ]
    }

    const TOTAL: u64 = 20_000 + 200 + 100 + 8;

    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A spec pinning exactly what `bodies()` serves.
    fn test_spec() -> ModelSpec {
        ModelSpec {
            base_url: BASE.into(),
            revision: "test-revision".into(),
            dir: "parakeet-test".into(),
            files: bodies().iter().map(|(name, body)| ModelFile::new(name, body.len() as u64, &sha(body))).collect(),
        }
    }

    /// What the fake server answers for one file.
    #[derive(Clone)]
    struct Served {
        body: Vec<u8>,
        /// The `Content-Length` it announces.
        length: Option<u64>,
        /// Answer with this error instead of a body.
        error: Option<String>,
    }

    fn served() -> HashMap<String, Served> {
        bodies()
            .into_iter()
            .map(|(name, body)| (name.to_string(), Served { length: Some(body.len() as u64), body, error: None }))
            .collect()
    }

    /// Holds a body after its first chunk, so a test can look at a download in flight.
    #[derive(Default)]
    struct Pause {
        /// (reached, released)
        state: Mutex<(bool, bool)>,
        changed: Condvar,
    }

    impl Pause {
        fn wait_reached(&self) {
            let mut state = self.state.lock().unwrap();
            while !state.0 {
                state = self.changed.wait_timeout(state, Duration::from_secs(5)).unwrap().0;
            }
        }

        fn release(&self) {
            self.state.lock().unwrap().1 = true;
            self.changed.notify_all();
        }

        fn hold(&self) {
            let mut state = self.state.lock().unwrap();
            state.0 = true;
            self.changed.notify_all();
            while !state.1 {
                state = self.changed.wait(state).unwrap();
            }
        }
    }

    struct Body {
        data: Cursor<Vec<u8>>,
        chunk: usize,
        pause: Option<Arc<Pause>>,
        clock: Arc<FakeClock>,
        served: usize,
    }

    impl Read for Body {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if let (Some(pause), true) = (&self.pause, self.served > 0) {
                pause.hold();
            }
            let n = buf.len().min(self.chunk);
            let read = self.data.read(&mut buf[..n])?;
            self.served += read;
            self.clock.advance(100);
            Ok(read)
        }
    }

    /// Serves each file by the last segment of its URL.
    struct FakeFetcher {
        files: HashMap<String, Served>,
        chunk: usize,
        pause: Option<Arc<Pause>>,
        clock: Arc<FakeClock>,
        urls: Mutex<Vec<String>>,
    }

    impl Fetcher for FakeFetcher {
        fn open(&self, url: &str) -> Result<Download, String> {
            self.urls.lock().unwrap().push(url.to_string());
            let name = url.rsplit('/').next().unwrap_or_default();
            let served = self.files.get(name).ok_or_else(|| "HTTP 404 Not Found".to_string())?;
            if let Some(error) = &served.error {
                return Err(error.clone());
            }
            let body = Body {
                data: Cursor::new(served.body.clone()),
                chunk: self.chunk,
                pause: self.pause.clone(),
                clock: self.clock.clone(),
                served: 0,
            };
            Ok(Download { body: Box::new(body), length: served.length })
        }
    }

    struct Rig {
        manager: ModelManager,
        fetcher: Arc<FakeFetcher>,
        events: mpsc::Receiver<ModelEvent>,
        root: PathBuf,
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("gentle-dot-model-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    fn rig(name: &str, spec: ModelSpec, files: HashMap<String, Served>, pause: Option<Arc<Pause>>) -> Rig {
        let clock = Arc::new(FakeClock(AtomicU64::new(0)));
        let fetcher = Arc::new(FakeFetcher { files, chunk: 512, pause, clock: clock.clone(), urls: Mutex::default() });
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let root = temp_root(name);
        let manager = ModelManager::new(
            spec,
            root.clone(),
            fetcher.clone(),
            clock,
            Arc::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            }),
            EngineName::Apple,
        );
        Rig { manager, fetcher, events, root }
    }

    /// A rig serving the files the spec pins.
    fn good_rig(name: &str) -> Rig {
        rig(name, test_spec(), served(), None)
    }

    impl Rig {
        /// Every event up to and including the next terminal one.
        fn until_done(&self) -> Vec<ModelEvent> {
            let mut seen = Vec::new();
            loop {
                let event = self.events.recv_timeout(Duration::from_secs(10)).expect("a model event");
                let done = matches!(event.state, ModelState::Installed | ModelState::Failed | ModelState::Removed | ModelState::Switched);
                seen.push(event);
                if done {
                    return seen;
                }
            }
        }

        fn leftovers(&self) -> Vec<String> {
            let Ok(entries) = std::fs::read_dir(&self.root) else { return Vec::new() };
            let mut names: Vec<String> = entries.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }

        /// Downloads and expects a failure that leaves nothing behind; its message.
        fn fails_cleanly(&self) -> String {
            self.manager.download().unwrap();
            let last = self.until_done().pop().unwrap();
            assert_eq!(last.state, ModelState::Failed);
            assert_eq!(self.manager.installed(), None);
            assert!(self.leftovers().is_empty(), "staging removed: {:?}", self.leftovers());
            assert!(!self.manager.status().downloading);
            last.message.unwrap()
        }
    }

    #[test]
    fn the_pinned_parakeet_asset_is_the_official_int8_release() {
        let spec = ModelSpec::parakeet();
        assert_eq!(
            spec.base_url,
            "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78"
        );
        assert_eq!(spec.revision, "2bda32ec70b097a55adaa07d9a7173915b43cc78");
        assert_eq!(spec.dir, "parakeet-tdt-0.6b-v3-int8");
        let pinned: Vec<(&str, u64, &str)> = spec.files.iter().map(|f| (f.name.as_str(), f.size, f.sha256.as_str())).collect();
        assert_eq!(
            pinned,
            [
                ("encoder.int8.onnx", 652_184_281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
                ("decoder.int8.onnx", 11_845_275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
                ("joiner.int8.onnx", 6_355_277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
                ("tokens.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
            ]
        );
        assert_eq!(spec.total(), 670_478_772);
        assert_eq!(
            spec.url(&spec.files[3]),
            "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/tokens.txt"
        );
    }

    #[test]
    fn status_before_any_download_reports_the_fallback_engine() {
        let rig = good_rig("status");
        let status = rig.manager.status();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"installed": false, "downloading": false, "enabled": true, "engine": "apple"})
        );
        assert_eq!(rig.manager.installed(), None);
    }

    #[test]
    fn a_download_fetches_every_file_reports_progress_verifies_and_installs() {
        let rig = good_rig("install");
        rig.manager.download().unwrap();
        let events = rig.until_done();
        let urls: Vec<String> = FILES.iter().map(|name| format!("{BASE}/{name}")).collect();
        assert_eq!(*rig.fetcher.urls.lock().unwrap(), urls, "each file from its own URL, in order");

        let first = &events[0];
        assert_eq!((first.state, first.received, first.total), (ModelState::Downloading, Some(0), Some(TOTAL)));
        let downloading: Vec<&ModelEvent> = events.iter().filter(|e| e.state == ModelState::Downloading).collect();
        assert!(downloading.iter().all(|e| e.total == Some(TOTAL)), "the total is every file together");
        let progress: Vec<u64> = downloading.iter().filter_map(|e| e.received).collect();
        assert!(progress.windows(2).all(|w| w[0] < w[1]), "progress grows across files: {progress:?}");
        assert_eq!(progress.last(), Some(&TOTAL), "the last progress is every file");
        assert!(progress.len() < (TOTAL as usize).div_ceil(512), "progress is throttled ({} events)", progress.len());
        let states: Vec<ModelState> = events.iter().map(|e| e.state).filter(|s| *s != ModelState::Downloading).collect();
        assert_eq!(states, [ModelState::Verifying, ModelState::Installed], "verifying follows the last progress");
        let verifying = events.iter().position(|e| e.state == ModelState::Verifying).unwrap();
        assert!(events[verifying..].iter().all(|e| e.state != ModelState::Downloading));

        let dir = rig.root.join("parakeet-test");
        assert_eq!(rig.manager.installed(), Some(dir.clone()));
        let mut names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, [".source", "decoder.int8.onnx", "encoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]);
        for (name, body) in bodies() {
            assert_eq!(std::fs::read(dir.join(name)).unwrap(), body, "{name}");
        }
        assert_eq!(std::fs::read_to_string(dir.join(".source")).unwrap(), "test-revision", "the install names its source");
        assert_eq!(rig.leftovers(), ["parakeet-test"], "no staging files remain");

        let status = rig.manager.status();
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"installed": true, "bytes": TOTAL, "downloading": false, "enabled": true, "engine": "parakeet"})
        );
        assert_eq!(rig.manager.download(), Err(ModelError::Installed));
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_checksum_mismatch_on_one_file_fails_names_it_and_leaves_nothing_behind() {
        let mut files = served();
        files.get_mut("joiner.int8.onnx").unwrap().body = vec![9u8; 100];
        let rig = rig("mismatch", test_spec(), files, None);
        let message = rig.fails_cleanly();
        assert_eq!(message, "The download of joiner.int8.onnx did not match the published checksum.");
        assert!(!rig.fetcher.urls.lock().unwrap().iter().any(|url| url.ends_with("tokens.txt")), "it stops at the bad file");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_file_of_the_wrong_size_fails_and_names_it() {
        // Announced with the wrong length.
        let mut files = served();
        files.get_mut("decoder.int8.onnx").unwrap().length = Some(199);
        let rig1 = rig("size-header", test_spec(), files, None);
        assert_eq!(rig1.fails_cleanly(), "The download of decoder.int8.onnx was not the expected size.");
        let _ = std::fs::remove_dir_all(&rig1.root);

        // No length announced, and the body runs long.
        let mut files = served();
        let tokens = files.get_mut("tokens.txt").unwrap();
        tokens.body.push(b'!');
        tokens.length = None;
        let rig2 = rig("size-long", test_spec(), files, None);
        assert_eq!(rig2.fails_cleanly(), "The download of tokens.txt was not the expected size.");
        let _ = std::fs::remove_dir_all(&rig2.root);

        // No length announced, and the body ends short.
        let mut files = served();
        let encoder = files.get_mut("encoder.int8.onnx").unwrap();
        encoder.body.truncate(10_000);
        encoder.length = None;
        let rig3 = rig("size-short", test_spec(), files, None);
        assert_eq!(rig3.fails_cleanly(), "The download of encoder.int8.onnx was not the expected size.");
        let _ = std::fs::remove_dir_all(&rig3.root);
    }

    #[test]
    fn an_http_error_on_one_file_fails_cleanly() {
        let mut files = served();
        files.get_mut("joiner.int8.onnx").unwrap().error = Some("HTTP 503 Service Unavailable".into());
        let rig = rig("http", test_spec(), files, None);
        let message = rig.fails_cleanly();
        assert_eq!(message, "The local voice model could not be downloaded (joiner.int8.onnx): HTTP 503 Service Unavailable");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_download_in_flight_is_reported_not_installed_and_can_be_cancelled() {
        let pause = Arc::new(Pause::default());
        let rig = rig("cancel", test_spec(), served(), Some(pause.clone()));
        rig.manager.download().unwrap();
        pause.wait_reached();

        let status = rig.manager.status();
        assert!(status.downloading && !status.installed);
        assert_eq!((status.received, status.total), (Some(512), Some(TOTAL)));
        assert_eq!(rig.manager.download(), Err(ModelError::Downloading));
        assert_eq!(rig.manager.remove(), Err(ModelError::Downloading));
        assert!(!rig.root.join("parakeet-test").exists(), "nothing is installed until the end");
        assert!(rig.root.join(".parakeet-test.download").exists(), "the download stages next to the install");

        assert!(rig.manager.cancel());
        pause.release();
        let last = rig.until_done().pop().unwrap();
        assert_eq!(last.state, ModelState::Failed);
        assert_eq!(last.message.as_deref(), Some("The download was cancelled."));
        assert!(rig.leftovers().is_empty(), "staging removed: {:?}", rig.leftovers());
        assert!(!rig.manager.status().downloading);
        assert!(!rig.manager.cancel(), "nothing left to cancel");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn the_installed_model_can_be_turned_off_and_on_without_deleting_it() {
        let rig = good_rig("switch");
        rig.manager.download().unwrap();
        assert_eq!(rig.until_done().pop().unwrap().state, ModelState::Installed);
        assert!(rig.manager.status().enabled);
        assert_eq!(rig.manager.status().engine, EngineName::Parakeet);

        rig.manager.set_enabled(false).unwrap();
        assert_eq!(rig.until_done(), vec![ModelEvent::state(ModelState::Switched)]);
        let off = rig.manager.status();
        assert!(off.installed, "turning it off keeps the files");
        assert!(!off.enabled);
        assert_eq!(off.engine, EngineName::Apple);
        assert_eq!(rig.manager.active(), None);
        assert!(rig.manager.installed().is_some());

        // The choice outlives the app: a new manager on the same folder still has it off.
        let again = ModelManager::new(
            test_spec(),
            rig.root.clone(),
            rig.fetcher.clone(),
            Arc::new(FakeClock(AtomicU64::new(0))),
            Arc::new(|_| {}),
            EngineName::Apple,
        );
        assert!(!again.status().enabled);

        rig.manager.set_enabled(true).unwrap();
        assert_eq!(rig.until_done(), vec![ModelEvent::state(ModelState::Switched)]);
        assert_eq!(rig.manager.status().engine, EngineName::Parakeet);
        assert_eq!(rig.manager.active(), rig.manager.installed());
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn removing_the_model_forgets_that_it_was_off() {
        let rig = good_rig("switch-remove");
        rig.manager.download().unwrap();
        rig.until_done();
        rig.manager.set_enabled(false).unwrap();
        rig.until_done();
        rig.manager.remove().unwrap();
        rig.until_done();
        assert!(rig.leftovers().is_empty());
        assert!(rig.manager.status().enabled);
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn remove_deletes_the_model_and_reports_it() {
        let rig = good_rig("remove");
        rig.manager.download().unwrap();
        assert_eq!(rig.until_done().pop().unwrap().state, ModelState::Installed);

        rig.manager.remove().unwrap();
        assert_eq!(rig.until_done(), vec![ModelEvent::state(ModelState::Removed)]);
        assert_eq!(rig.manager.installed(), None);
        assert!(rig.leftovers().is_empty());
        assert_eq!(rig.manager.status().engine, EngineName::Apple);
        rig.manager.remove().unwrap();
        assert!(rig.events.try_recv().is_err(), "removing nothing reports nothing");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn a_staging_directory_left_by_a_crash_is_cleared_by_the_next_download() {
        let rig = good_rig("stale");
        let stale = rig.root.join(".parakeet-test.download");
        std::fs::create_dir_all(stale.join("model")).unwrap();
        std::fs::write(stale.join("model").join("encoder.int8.onnx"), b"partial").unwrap();
        rig.manager.download().unwrap();
        assert_eq!(rig.until_done().pop().unwrap().state, ModelState::Installed);
        assert_eq!(rig.leftovers(), ["parakeet-test"]);
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn an_incomplete_install_does_not_count() {
        let rig = good_rig("partial");
        let dir = rig.root.join("parakeet-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tokens.txt"), b"t").unwrap();
        assert_eq!(rig.manager.installed(), None);
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    #[test]
    fn an_install_from_the_earlier_archive_without_a_source_marker_still_counts() {
        let rig = good_rig("legacy");
        let dir = rig.root.join("parakeet-test");
        std::fs::create_dir_all(&dir).unwrap();
        for name in FILES {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        assert_eq!(rig.manager.installed(), Some(dir.clone()));
        assert_eq!(rig.manager.status().bytes, Some(4));
        assert_eq!(rig.manager.download(), Err(ModelError::Installed), "no forced re-download");
        let _ = std::fs::remove_dir_all(&rig.root);
    }

    /// Serves each file from a local directory holding the real model files.
    struct DirFetcher(PathBuf);

    impl Fetcher for DirFetcher {
        fn open(&self, url: &str) -> Result<Download, String> {
            let name = url.rsplit('/').next().unwrap_or_default();
            let file = std::fs::File::open(self.0.join(name)).map_err(|e| format!("{name}: {e}"))?;
            let length = file.metadata().map_err(|e| e.to_string())?.len();
            Ok(Download { body: Box::new(file), length: Some(length) })
        }
    }

    /// Installs from local copies of the four real files, checking every pinned size and SHA-256.
    /// Run with
    /// `GENTLE_DOT_PARAKEET_DIR=<dir with the 4 files> cargo test -- --ignored real_parakeet_files`.
    #[test]
    #[ignore = "needs the real Parakeet files (670 MB)"]
    fn real_parakeet_files_install() {
        let Some(source) = std::env::var_os("GENTLE_DOT_PARAKEET_DIR").map(PathBuf::from) else {
            eprintln!("GENTLE_DOT_PARAKEET_DIR is not set; skipping");
            return;
        };
        let (tx, events) = mpsc::channel();
        let tx = Mutex::new(tx);
        let root = temp_root("real");
        let manager = ModelManager::new(
            ModelSpec::parakeet(),
            root.clone(),
            Arc::new(DirFetcher(source)),
            Arc::new(crate::computer::SystemClock),
            Arc::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            }),
            EngineName::Apple,
        );
        let started = std::time::Instant::now();
        manager.download().unwrap();
        let last = loop {
            let event: ModelEvent = events.recv_timeout(Duration::from_secs(600)).unwrap();
            if matches!(event.state, ModelState::Installed | ModelState::Failed) {
                break event;
            }
        };
        eprintln!("installed in {:?}: {:?}", started.elapsed(), manager.status());
        assert_eq!(last.state, ModelState::Installed, "{:?}", last.message);
        assert_eq!(manager.status().bytes, Some(670_478_772));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Fetches only `tokens.txt` (94 KB) from the pinned Hugging Face URL through the real HTTPS
    /// fetcher, following its redirect, and checks the pinned size and SHA-256. Run with
    /// `cargo test -- --ignored real_hugging_face_serves`.
    #[test]
    #[ignore = "needs the network"]
    fn real_hugging_face_serves_the_pinned_tokens() {
        let spec = ModelSpec::parakeet();
        let tokens = spec.files.iter().find(|f| f.name == "tokens.txt").unwrap();
        let Download { mut body, length } = HttpFetcher.open(&spec.url(tokens)).unwrap();
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes).unwrap();
        eprintln!("tokens.txt: {} bytes (Content-Length {length:?}), sha256 {}", bytes.len(), sha(&bytes));
        assert_eq!(bytes.len() as u64, tokens.size);
        assert_eq!(sha(&bytes), tokens.sha256);
    }

    #[test]
    fn events_carry_the_contract_shape() {
        assert_eq!(MODEL_EVENT, "voice://model");
        let progress = ModelEvent { state: ModelState::Downloading, received: Some(5), total: Some(10), message: None };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            serde_json::json!({"state": "downloading", "received": 5, "total": 10})
        );
        let failed = ModelEvent::failed("no");
        assert_eq!(serde_json::to_value(failed).unwrap(), serde_json::json!({"state": "failed", "message": "no"}));
        for (state, name) in [
            (ModelState::Verifying, "verifying"),
            (ModelState::Installed, "installed"),
            (ModelState::Removed, "removed"),
        ] {
            assert_eq!(serde_json::to_value(ModelEvent::state(state)).unwrap(), serde_json::json!({"state": name}));
        }
        for (engine, name) in [(EngineName::Parakeet, "parakeet"), (EngineName::Apple, "apple"), (EngineName::None, "none")] {
            assert_eq!(serde_json::to_value(engine).unwrap(), serde_json::json!(name));
        }
    }
}
