//! The bundled llama.cpp server (`llama\llama-server.exe`) that runs the AI
//! cleanup model. It is a separate process: whisper-rs links its own copy of
//! ggml into rudariflow.exe, and two copies cannot share one process.
//!
//! One server at a time, on 127.0.0.1 with a random port and API key. On
//! Windows it runs in a Job Object with kill-on-close, so it never outlives
//! RudariFlow, not even after a crash.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::audio::lock;
use crate::startup_log;

/// A device as `llama-server --list-devices` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct LlamaDevice {
    /// Name for `-dev`, e.g. "Vulkan0".
    pub id: String,
    /// GPU name, e.g. "AMD Radeon RX 6800".
    pub name: String,
    pub total_mib: u64,
}

/// Parse lines like `  Vulkan0: AMD Radeon RX 6800 (16368 MiB, 15569 MiB free)`.
pub fn parse_devices(output: &str) -> Vec<LlamaDevice> {
    output
        .lines()
        .filter_map(|line| {
            let (id, rest) = line.trim().split_once(": ")?;
            if id.is_empty() || id.contains(char::is_whitespace) {
                return None;
            }
            let open = rest.rfind(" (")?;
            let total_mib = rest[open + 2..].split_whitespace().next()?.parse().ok()?;
            Some(LlamaDevice {
                id: id.to_string(),
                name: rest[..open].trim().to_string(),
                total_mib,
            })
        })
        .collect()
}

/// The GPU Whisper uses (matched by name, which is the same for an NVIDIA
/// card under CUDA and Vulkan), else the one with the most memory. `None`
/// means CPU.
pub fn pick_device<'a>(devices: &'a [LlamaDevice], whisper_gpu: Option<&str>) -> Option<&'a LlamaDevice> {
    if let Some(name) = whisper_gpu {
        let wanted = name.trim().to_lowercase();
        if let Some(d) = devices.iter().find(|d| d.name.trim().to_lowercase() == wanted) {
            return Some(d);
        }
    }
    devices.iter().max_by_key(|d| d.total_mib)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ServerStatus {
    Stopped,
    Loading,
    Ready { device: String },
    Failed { error: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub base_url: String,
    pub api_key: String,
    /// No GPU: requests get the longer CPU time limits.
    pub on_cpu: bool,
}

pub type StatusCallback = Box<dyn Fn(&ServerStatus) + Send + Sync>;

struct Running {
    child: Child,
    endpoint: Endpoint,
    model: PathBuf,
}

/// Starts after a crash or failed start are retried this often, then the
/// server stays off until the settings change or the user retries.
const MAX_START_FAILURES: u32 = 2;
/// Loading a large model from a slow disk can take a while.
const LOAD_TIMEOUT: Duration = Duration::from_secs(180);
const LIST_DEVICES_TIMEOUT: Duration = Duration::from_secs(20);

pub struct LlmServer {
    llama_dir: PathBuf,
    log_path: PathBuf,
    running: Mutex<Option<Running>>,
    status: Mutex<ServerStatus>,
    /// Serialises starts; concurrent callers wait for the one in progress.
    start_lock: tokio::sync::Mutex<()>,
    devices: Mutex<Option<Vec<LlamaDevice>>>,
    failures: AtomicU32,
    /// Bumped by `stop`, so a start that was cut short does not report failure.
    generation: AtomicU64,
    on_status: StatusCallback,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl LlmServer {
    pub fn new(llama_dir: PathBuf, log_path: PathBuf, on_status: StatusCallback) -> Self {
        Self {
            llama_dir,
            log_path,
            running: Mutex::new(None),
            status: Mutex::new(ServerStatus::Stopped),
            start_lock: tokio::sync::Mutex::new(()),
            devices: Mutex::new(None),
            failures: AtomicU32::new(0),
            generation: AtomicU64::new(0),
            on_status,
            #[cfg(windows)]
            job: job::Job::new(),
        }
    }

    fn server_exe(&self) -> PathBuf {
        self.llama_dir.join("llama-server.exe")
    }

    pub fn is_installed(&self) -> bool {
        self.server_exe().exists()
    }

    pub fn status(&self) -> ServerStatus {
        lock(&self.status).clone()
    }

    fn set_status(&self, status: ServerStatus) {
        let mut current = lock(&self.status);
        if *current != status {
            *current = status.clone();
            drop(current);
            (self.on_status)(&status);
        }
    }

    /// The endpoint if a server for `model` is running and ready. Notices a
    /// server that crashed since the last call.
    pub fn ready_endpoint_now(&self, model: &Path) -> Option<Endpoint> {
        if self.reap_if_exited() {
            return None;
        }
        let running = lock(&self.running);
        let r = running.as_ref()?;
        let ready = r.model == model && matches!(*lock(&self.status), ServerStatus::Ready { .. });
        ready.then(|| r.endpoint.clone())
    }

    /// If the server process has exited on its own, forget it, count the
    /// failure and report it. Returns whether it had exited.
    fn reap_if_exited(&self) -> bool {
        let mut running = lock(&self.running);
        let Some(r) = running.as_mut() else { return false };
        let Ok(Some(code)) = r.child.try_wait() else { return false };
        *running = None;
        drop(running);
        startup_log::log(&format!("[ai] llama-server stopped unexpectedly ({})", code));
        self.failures.fetch_add(1, Ordering::SeqCst);
        self.set_status(ServerStatus::Failed {
            error: format!("The AI model stopped unexpectedly ({})", code),
        });
        true
    }

    /// A request could not reach the server. That usually means it died, but
    /// a process holding gigabytes of GPU memory takes a moment to exit, so
    /// watch for a few seconds; once it is gone, start it again in the
    /// background (within the failure limit) so the next dictation finds it.
    pub fn request_failed(self: &Arc<Self>, model: PathBuf, gpu_backend: Option<String>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            for _ in 0..25 {
                tokio::time::sleep(Duration::from_millis(200)).await;
                if this.reap_if_exited() {
                    this.warm(model, gpu_backend);
                    return;
                }
            }
        });
    }

    fn gave_up(&self) -> Option<String> {
        if self.failures.load(Ordering::SeqCst) < MAX_START_FAILURES {
            return None;
        }
        Some(match self.status() {
            ServerStatus::Failed { error } => error,
            _ => "The AI model could not be started".to_string(),
        })
    }

    /// Start the server for `model` unless it already runs, and return once
    /// it is ready. Serialised with other starts. `gpu_backend` is Whisper's
    /// setting; the server runs on the GPU Whisper would use.
    pub async fn ensure_running(&self, model: &Path, gpu_backend: Option<&str>) -> Result<Endpoint, String> {
        let _start = self.start_lock.lock().await;
        if let Some(endpoint) = self.ready_endpoint_now(model) {
            return Ok(endpoint);
        }
        if let Some(error) = self.gave_up() {
            return Err(error);
        }
        let generation = self.generation.load(Ordering::SeqCst);
        match self.start(model, gpu_backend).await {
            Ok(endpoint) => {
                self.failures.store(0, Ordering::SeqCst);
                Ok(endpoint)
            }
            Err(_) if self.generation.load(Ordering::SeqCst) != generation => {
                Err("The AI model was stopped".to_string())
            }
            Err(error) => {
                self.kill();
                self.failures.fetch_add(1, Ordering::SeqCst);
                startup_log::log(&format!("[ai] start failed: {}", error));
                self.set_status(ServerStatus::Failed { error: error.clone() });
                Err(error)
            }
        }
    }

    /// Start (or keep) the server in the background, e.g. on hotkey press.
    pub fn warm(self: &Arc<Self>, model: PathBuf, gpu_backend: Option<String>) {
        if self.gave_up().is_some() || self.ready_endpoint_now(&model).is_some() {
            return;
        }
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = this.ensure_running(&model, gpu_backend.as_deref()).await;
        });
    }

    /// The endpoint once the server for `model` is ready, starting it in the
    /// background if needed. Gives up after `wait`; the start continues.
    pub async fn wait_ready(
        self: &Arc<Self>,
        model: &Path,
        gpu_backend: Option<String>,
        wait: Duration,
    ) -> Result<Endpoint, String> {
        if let Some(endpoint) = self.ready_endpoint_now(model) {
            return Ok(endpoint);
        }
        if let Some(error) = self.gave_up() {
            return Err(error);
        }
        self.warm(model.to_path_buf(), gpu_backend);
        let begun = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(endpoint) = self.ready_endpoint_now(model) {
                return Ok(endpoint);
            }
            // Once the start had time to begin, a failed and finished start
            // ends the wait early.
            if begun.elapsed() > Duration::from_millis(300) && self.start_lock.try_lock().is_ok() {
                if let ServerStatus::Failed { error } = self.status() {
                    return Err(error);
                }
            }
            if begun.elapsed() >= wait {
                return Err("The AI model is still loading".to_string());
            }
        }
    }

    async fn start(&self, model: &Path, gpu_backend: Option<&str>) -> Result<Endpoint, String> {
        self.kill();
        if !self.is_installed() {
            return Err(format!("llama-server not found in {}", self.llama_dir.display()));
        }
        if !model.exists() {
            return Err("The AI model is not downloaded".to_string());
        }
        self.set_status(ServerStatus::Loading);

        let devices = self.devices().await;
        let whisper_gpu = match gpu_backend {
            Some(backend) => {
                let backend = backend.to_string();
                tokio::task::spawn_blocking(move || crate::whisper_engine::preferred_gpu_name(&backend))
                    .await
                    .ok()
                    .flatten()
            }
            None => None,
        };
        let device = pick_device(&devices, whisper_gpu.as_deref()).cloned();
        let port = free_port()?;
        let api_key = random_key();
        let log = File::create(&self.log_path).map_err(|e| format!("llm-server.log: {}", e))?;
        let log_err = log.try_clone().map_err(|e| e.to_string())?;
        let port_arg = port.to_string();

        let mut cmd = Command::new(self.server_exe());
        cmd.current_dir(&self.llama_dir)
            .arg("-m")
            .arg(model)
            .args(["--host", "127.0.0.1", "--port", &port_arg, "--api-key", &api_key])
            .args(["-dev", device.as_ref().map_or("none", |d| d.id.as_str())])
            .args(["--fit", "on", "-c", "8192", "-np", "1", "--reasoning-budget", "0", "--no-webui"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        no_window(&mut cmd);

        let label = device.as_ref().map_or_else(|| "CPU".to_string(), |d| d.name.clone());
        startup_log::log(&format!("[ai] starting llama-server on {} with {}", label, model.display()));
        let started = Instant::now();
        let child = cmd.spawn().map_err(|e| format!("Could not start llama-server: {}", e))?;
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.assign(&child);
        }
        let endpoint = Endpoint {
            base_url: format!("http://127.0.0.1:{}", port),
            api_key,
            on_cpu: device.is_none(),
        };
        *lock(&self.running) = Some(Running {
            child,
            endpoint: endpoint.clone(),
            model: model.to_path_buf(),
        });

        self.wait_healthy(&endpoint).await?;
        // The first inference compiles GPU pipelines and fills the prompt
        // cache with the shared system prompt. Do it before reporting Ready,
        // so the first dictation is as fast as the ones after it.
        let (system, user) = crate::ai_cleanup::build_messages(
            "polished",
            "",
            &[],
            &[],
            &crate::ai_cleanup::AppContext::default(),
            None,
            None,
            "Hello.",
        );
        if let Err(e) = crate::ai_cleanup::complete(&endpoint, &system, &user, 0.0, 8, LOAD_TIMEOUT).await {
            startup_log::log(&format!("[ai] warm-up request failed: {}", e));
        }
        startup_log::log(&format!(
            "[ai] llama-server ready on {} after {} ms",
            label,
            started.elapsed().as_millis()
        ));
        self.set_status(ServerStatus::Ready { device: label });
        Ok(endpoint)
    }

    async fn wait_healthy(&self, endpoint: &Endpoint) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|e| e.to_string())?;
        let url = format!("{}/health", endpoint.base_url);
        let deadline = Instant::now() + LOAD_TIMEOUT;
        loop {
            let exited = match lock(&self.running).as_mut() {
                Some(r) => r.child.try_wait().ok().flatten().map(|code| code.to_string()),
                None => Some("stopped".to_string()),
            };
            if let Some(code) = exited {
                return Err(format!("The AI model failed to load ({}); see llm-server.log", code));
            }
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err("The AI model did not finish loading in time".to_string());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    /// Devices from `llama-server --list-devices`, asked once per app run.
    async fn devices(&self) -> Vec<LlamaDevice> {
        if let Some(devices) = lock(&self.devices).clone() {
            return devices;
        }
        let mut cmd = Command::new(self.server_exe());
        cmd.current_dir(&self.llama_dir).arg("--list-devices").stdin(Stdio::null());
        no_window(&mut cmd);
        let output = tokio::time::timeout(
            LIST_DEVICES_TIMEOUT,
            tokio::task::spawn_blocking(move || cmd.output()),
        )
        .await;
        let devices = match output {
            Ok(Ok(Ok(out))) => parse_devices(&format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )),
            _ => Vec::new(),
        };
        startup_log::log(&format!("[ai] devices: {:?}", devices));
        *lock(&self.devices) = Some(devices.clone());
        devices
    }

    fn kill(&self) {
        if let Some(mut r) = lock(&self.running).take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }

    /// Stop the server: feature switched off, model changed, app exit. Also
    /// clears earlier failures, so the next start is tried again.
    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.kill();
        self.failures.store(0, Ordering::SeqCst);
        self.set_status(ServerStatus::Stopped);
    }
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| format!("No free local port: {}", e))
}

fn random_key() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // Still unique per start; the server only listens on 127.0.0.1.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes = (nanos ^ ((std::process::id() as u128) << 64)).to_le_bytes();
    }
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Kill-on-close job. The handle stays open for the app's lifetime;
    /// Windows closes it when RudariFlow exits, which ends the server.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(None, PCWSTR::null()).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;
                Some(Self(handle))
            }
        }

        pub fn assign(&self, child: &std::process::Child) {
            unsafe {
                if let Err(e) = AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle() as _)) {
                    crate::startup_log::log(&format!("[ai] job assignment failed: {}", e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIST: &str = "0.00.001.020 I srv  llama_server: initializing ...
Available devices:
  Vulkan0: AMD Radeon RX 6800 (16368 MiB, 15569 MiB free)
  Vulkan1: Intel(R) UHD Graphics 770 (8192 MiB, 8000 MiB free)
";

    #[test]
    fn parses_device_list() {
        let devices = parse_devices(LIST);
        assert_eq!(
            devices,
            vec![
                LlamaDevice { id: "Vulkan0".into(), name: "AMD Radeon RX 6800".into(), total_mib: 16368 },
                LlamaDevice { id: "Vulkan1".into(), name: "Intel(R) UHD Graphics 770".into(), total_mib: 8192 },
            ]
        );
        assert!(parse_devices("Available devices:\n").is_empty());
    }

    #[test]
    fn picks_whisper_gpu_then_most_memory_then_cpu() {
        let devices = parse_devices(LIST);
        assert_eq!(pick_device(&devices, Some("Intel(R) UHD Graphics 770")).unwrap().id, "Vulkan1");
        assert_eq!(pick_device(&devices, Some("NVIDIA GeForce RTX 4070")).unwrap().id, "Vulkan0");
        assert_eq!(pick_device(&devices, None).unwrap().id, "Vulkan0");
        assert!(pick_device(&[], None).is_none());
    }

    #[test]
    fn keys_and_ports() {
        let a = random_key();
        assert_eq!(a.len(), 32);
        assert_ne!(a, random_key());
        assert!(free_port().unwrap() > 0);
    }

    #[test]
    fn status_serialises_for_the_ui() {
        let json = serde_json::to_string(&ServerStatus::Ready { device: "RX 6800".into() }).unwrap();
        assert_eq!(json, r#"{"state":"ready","device":"RX 6800"}"#);
        assert_eq!(serde_json::to_string(&ServerStatus::Loading).unwrap(), r#"{"state":"loading"}"#);
    }
}
