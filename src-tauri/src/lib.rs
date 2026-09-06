use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize)]
struct ProgressPayload {
    id: String,
    percent: f32,
    speed: Option<String>,
    eta: Option<String>,
    raw: String,
}

#[derive(Clone, Serialize)]
struct CompletePayload {
    id: String,
    path: String,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    id: String,
    message: String,
    stderr: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct VideoMetadata {
    id: Option<String>,
    title: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    webpage_url: Option<String>,
}

#[derive(Clone, Serialize)]
struct SidecarVersions {
    ytdlp: Option<String>,
    ffmpeg: Option<String>,
}

fn children() -> &'static Mutex<HashMap<String, CommandChild>> {
    static MAP: OnceLock<Mutex<HashMap<String, CommandChild>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ids cancelled via `cancel_download`. Checked on Error / non-zero exit so a
/// kill is reported as "cancelled" instead of a crash, without depending on
/// platform-specific exit codes or signal numbers.
fn cancelled_ids() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn was_cancelled(id: &str) -> bool {
    cancelled_ids()
        .lock()
        .map(|mut s| s.remove(id))
        .unwrap_or(false)
}

fn emit_cancelled(app: &AppHandle, id: &str) {
    let _ = app.emit(
        "download-error",
        ErrorPayload {
            id: id.to_string(),
            message: "Download cancelled.".to_string(),
            stderr: String::new(),
        },
    );
}

/// FEAT-015: backend-side validation (frontend check alone is not enough —
/// `invoke` can be called from any webview context).
fn validate_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL must not be empty.".to_string());
    }
    if trimmed.len() > 2048 {
        return Err("URL is too long (max 2048 characters).".to_string());
    }
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Enter a valid URL starting with http:// or https://".to_string());
    }
    Ok(trimmed.to_string())
}

/// FEAT-015: `output_dir` comes from the dialog picker or stored settings —
/// never trust pasted text blindly.
fn validate_output_dir(dir: &str) -> Result<String, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        return Err("Output directory must not be empty.".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    for seg in normalized.split('/') {
        if seg == ".." {
            return Err("Output directory must not contain '..'.".to_string());
        }
    }
    let path = PathBuf::from(trimmed);
    if path.exists() && !path.is_dir() {
        return Err("Output path exists but is not a directory.".to_string());
    }
    Ok(trimmed.trim_end_matches(['/', '\\']).to_string())
}

const DEFAULT_TEMPLATE: &str = "%(title)s.%(ext)s";

/// FEAT-007: validate a yt-dlp `-o` filename template fragment (no directory
/// parts — the output dir is always prepended by us).
fn validate_template(raw: Option<String>) -> Result<String, String> {
    let t = raw
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_TEMPLATE.to_string());
    if t.len() > 256 {
        return Err("Filename template is too long (max 256 characters).".to_string());
    }
    if !t.contains("%(ext)s") {
        return Err("Filename template must contain %(ext)s.".to_string());
    }
    if t.contains("..") || t.contains('/') || t.contains('\\') || t.contains(':') {
        return Err(
            "Filename template must be a bare filename (no paths, '..' or ':').".to_string(),
        );
    }
    Ok(t)
}

/// Target triple suffix used for the bundled sidecar binaries (Windows 11 x64).
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";
#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
const TARGET_TRIPLE: &str = "x86_64-pc-windows-msvc";

fn exe_extension() -> &'static str {
    if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    }
}

/// Resolve the directory containing the bundled `ffmpeg` sidecar so it can be
/// passed to yt-dlp via `--ffmpeg-location`.
///
/// Probes several candidate layouts because the bundle layout differs between
/// `tauri dev` (binaries live in `src-tauri/binaries/`) and a packaged build
/// (binaries live under the resource dir, with the target-triple suffix
/// stripped by Tauri at bundle time).
fn resolve_ffmpeg_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let stem = format!("ffmpeg-{}{}", TARGET_TRIPLE, exe_extension());
    let plain = format!("ffmpeg{}", exe_extension());

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("binaries").join(&stem));
        candidates.push(resource_dir.join("binaries").join(&plain));
        candidates.push(resource_dir.join(&stem));
        candidates.push(resource_dir.join(&plain));
    }

    // Dev-mode fallback: walk up from the current exe
    // (<root>/src-tauri/target/debug/downloader-app.exe -> <root>/src-tauri/binaries/...)
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(PathBuf::from);
        for _ in 0..6 {
            if let Some(d) = dir.clone() {
                candidates.push(d.join("binaries").join(&stem));
                candidates.push(d.join("binaries").join(&plain));
                candidates.push(d.join(&stem));
                dir = d.parent().map(PathBuf::from);
            } else {
                break;
            }
        }
    }

    for candidate in &candidates {
        if candidate.is_file() {
            return candidate
                .parent()
                .map(PathBuf::from)
                .ok_or_else(|| "Could not determine ffmpeg parent directory.".to_string());
        }
    }

    Err(format!(
        "Bundled ffmpeg sidecar not found. Looked for '{}' / '{}' next to the app resources and in src-tauri/binaries. \
         Place 'ffmpeg-{}'{} in src-tauri/binaries/ and rebuild.",
        stem,
        plain,
        TARGET_TRIPLE,
        exe_extension()
    ))
}

fn build_format_args(format: &str, quality: &str) -> Vec<String> {
    if format == "mp3" {
        return vec![
            "-x".to_string(),
            "--audio-format".to_string(),
            "mp3".to_string(),
        ];
    }

    let selector = match quality {
        "2160p" => "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
        "1440p" => "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best",
        "1080p" => "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "720p" => "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        "480p" => "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
        "360p" => "bestvideo[height<=360]+bestaudio/best[height<=360]/best",
        _ => "bestvideo+bestaudio/best",
    };

    vec![
        "-f".to_string(),
        selector.to_string(),
        "--merge-output-format".to_string(),
        "mp4".to_string(),
    ]
}

#[tauri::command]
async fn download_media(
    app: AppHandle,
    id: String,
    url: String,
    format: String,
    quality: String,
    output_dir: String,
    playlist: Option<String>,
    filename_template: Option<String>,
) -> Result<String, String> {
    if id.trim().is_empty() || id.len() > 64 {
        return Err("Invalid download id.".to_string());
    }
    let url = validate_url(&url)?;
    let output_dir = validate_output_dir(&output_dir)?;
    let template = validate_template(filename_template)?;

    let ffmpeg_dir = resolve_ffmpeg_dir(&app)?;
    let ffmpeg_location = ffmpeg_dir.to_string_lossy().to_string();

    let output_template = format!("{output_dir}/{template}");

    let mut args = build_format_args(&format, &quality);
    args.push("--newline".to_string());
    args.push("--progress".to_string());
    // FEAT-012 (quick win): resume partial files + retry transient failures.
    args.push("--continue".to_string());
    args.push("--retries".to_string());
    args.push("10".to_string());
    args.push("--fragment-retries".to_string());
    args.push("10".to_string());
    args.push("--retry-sleep".to_string());
    args.push("exp=1:5".to_string());
    // FEAT-007: keep Windows-legal filenames, cap absurd lengths.
    args.push("--windows-filenames".to_string());
    args.push("--trim-filenames".to_string());
    args.push("200".to_string());
    // FEAT-004: playlist mode. Default (None/"single") keeps old behaviour.
    if playlist.as_deref() == Some("full") {
        args.push("--yes-playlist".to_string());
    } else {
        args.push("--no-playlist".to_string());
    }
    args.push("--ffmpeg-location".to_string());
    args.push(ffmpeg_location);
    args.push("-o".to_string());
    args.push(output_template);
    args.push(url.clone());

    let command = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Failed to resolve yt-dlp sidecar: {e}. Did you place 'yt-dlp-{}{}' in src-tauri/binaries/?", TARGET_TRIPLE, exe_extension()))?
        .args(args);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp sidecar: {e}"))?;

    // FEAT-002: keep the child so `cancel_download` can kill it.
    children()
        .lock()
        .map_err(|_| "Internal lock error.".to_string())?
        .insert(id.clone(), child);

    let progress_re = Regex::new(r"\[download\]\s+(\d+(?:\.\d+)?)%").expect("valid progress regex");
    let dest_re = Regex::new(r"\[download\]\s+Destination:\s+(.+)").expect("valid dest regex");
    let merge_re = Regex::new(r"\[(?:Merge|ExtractAudio)\][^\n]*Destination:\s+(.+)")
        .expect("valid merge regex");
    let speed_re = Regex::new(r"at\s+(\S+/s)").expect("valid speed regex");
    let eta_re = Regex::new(r"ETA\s+(\S+)").expect("valid eta regex");

    let mut stderr_buf = String::new();
    let mut final_path = String::new();

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line).to_string();
                for raw in text.lines() {
                    let line = raw.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Some(cap) = dest_re.captures(line) {
                        final_path = cap[1].trim().to_string();
                    } else if let Some(cap) = merge_re.captures(line) {
                        final_path = cap[1].trim().to_string();
                    }
                    if let Some(cap) = progress_re.captures(line) {
                        let percent: f32 = cap[1].parse().unwrap_or(0.0);
                        let speed = speed_re.captures(line).map(|c| c[1].to_string());
                        let eta = eta_re.captures(line).map(|c| c[1].to_string());
                        let _ = app.emit(
                            "download-progress",
                            ProgressPayload {
                                id: id.clone(),
                                percent,
                                speed,
                                eta,
                                raw: line.to_string(),
                            },
                        );
                    }
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                stderr_buf.push_str(&text);
            }
            CommandEvent::Error(message) => {
                let _ = children().lock().map(|mut m| m.remove(&id));
                if was_cancelled(&id) {
                    emit_cancelled(&app, &id);
                    return Err("Download cancelled.".to_string());
                }
                let _ = app.emit(
                    "download-error",
                    ErrorPayload {
                        id: id.clone(),
                        message: format!("yt-dlp process error: {message}"),
                        stderr: stderr_buf.clone(),
                    },
                );
                return Err(format!("yt-dlp process error: {message}"));
            }
            CommandEvent::Terminated(payload) => {
                let _ = children().lock().map(|mut m| m.remove(&id));
                let code = payload.code.unwrap_or(-1);
                if code != 0 && was_cancelled(&id) {
                    emit_cancelled(&app, &id);
                    return Err("Download cancelled.".to_string());
                }
                if code == 0 {
                    let path = if final_path.is_empty() {
                        output_dir.clone()
                    } else {
                        final_path.clone()
                    };
                    let _ = app.emit(
                        "download-complete",
                        CompletePayload {
                            id: id.clone(),
                            path: path.clone(),
                        },
                    );
                    return Ok(path);
                } else {
                    let message = format!(
                        "yt-dlp exited with code {code} for URL '{url}'.\n{}",
                        stderr_buf.trim()
                    );
                    let _ = app.emit(
                        "download-error",
                        ErrorPayload {
                            id: id.clone(),
                            message: message.clone(),
                            stderr: stderr_buf.clone(),
                        },
                    );
                    return Err(message);
                }
            }
            _ => {}
        }
    }

    Err("yt-dlp sidecar ended without a termination signal.".to_string())
}

/// FEAT-002: cancel a running download. No new capability needed —
/// `shell:allow-kill` is already in `capabilities/default.json`.
#[tauri::command]
async fn cancel_download(id: String) -> Result<(), String> {
    let child = children()
        .lock()
        .map_err(|_| "Internal lock error.".to_string())?
        .remove(&id);
    match child {
        Some(c) => {
            // Mark first so the Error/Terminated event below is reported as a
            // cancellation rather than a crash.
            if let Ok(mut s) = cancelled_ids().lock() {
                s.insert(id);
            }
            c.kill()
                .map_err(|e| format!("Failed to cancel download: {e}"))
        }
        None => Err("Download is not running (already finished?).".to_string()),
    }
}

/// FEAT-003: metadata preview via `yt-dlp --dump-single-json`.
/// Playlist enforced to single item — full-list browsing is FEAT-004 follow-up.
#[tauri::command]
async fn fetch_metadata(app: AppHandle, url: String) -> Result<VideoMetadata, String> {
    let url = validate_url(&url)?;
    let (mut rx, child) = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("Failed to resolve yt-dlp sidecar: {e}"))?
        .args([
            "--dump-single-json",
            "--no-playlist",
            "--skip-download",
            "--no-warnings",
            &url,
        ])
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp sidecar: {e}"))?;
    drop(child);

    let mut stdout = String::new();
    let mut stderr_buf = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Stderr(line) => {
                stderr_buf.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Terminated(payload) => {
                if payload.code.unwrap_or(-1) != 0 {
                    let hint = stderr_buf.trim();
                    return Err(if hint.is_empty() {
                        "Could not fetch video info.".to_string()
                    } else if hint.contains("confirm your age") || hint.contains("Sign in") {
                        format!("This video needs login/cookies. {hint}")
                    } else {
                        hint.chars().take(600).collect()
                    });
                }
                break;
            }
            CommandEvent::Error(message) => {
                return Err(format!("yt-dlp process error: {message}"));
            }
            _ => {}
        }
    }

    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|_| "Could not parse video info.".to_string())?;
    Ok(VideoMetadata {
        id: v.get("id").and_then(|x| x.as_str()).map(str::to_string),
        title: v.get("title").and_then(|x| x.as_str()).map(str::to_string),
        uploader: v
            .get("uploader")
            .or_else(|| v.get("channel"))
            .and_then(|x| x.as_str())
            .map(str::to_string),
        duration: v.get("duration").and_then(|x| x.as_f64()),
        thumbnail: v
            .get("thumbnail")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        webpage_url: v
            .get("webpage_url")
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
}

/// FEAT-005: show bundled sidecar versions in Settings so users can tell a
/// stale yt-dlp (the usual cause of sudden YouTube failures) apart.
#[tauri::command]
async fn get_sidecar_versions(app: AppHandle) -> SidecarVersions {
    async fn first_line(app: &AppHandle, sidecar: &str, args: &[&str]) -> Option<String> {
        let (mut rx, child) = app.shell().sidecar(sidecar).ok()?.args(args).spawn().ok()?;
        drop(child);
        let mut out = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    out.push_str(&String::from_utf8_lossy(&line));
                    if out.lines().next().is_some_and(|l| !l.trim().is_empty()) {
                        break;
                    }
                }
                CommandEvent::Terminated(_) | CommandEvent::Error(_) => break,
                _ => {}
            }
        }
        let first = out.lines().map(str::trim).find(|l| !l.is_empty())?;
        Some(first.chars().take(80).collect())
    }

    let ytdlp = first_line(&app, "yt-dlp", &["--version"]).await;
    let ffmpeg = first_line(&app, "ffmpeg", &["-version"]).await;
    SidecarVersions { ytdlp, ffmpeg }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            download_media,
            cancel_download,
            fetch_metadata,
            get_sidecar_versions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_args_cover_extended_qualities() {
        for (q, needle) in [
            ("best", "bestvideo+bestaudio/best"),
            ("2160p", "height<=2160"),
            ("1440p", "height<=1440"),
            ("1080p", "height<=1080"),
            ("720p", "height<=720"),
            ("480p", "height<=480"),
            ("360p", "height<=360"),
        ] {
            let args = build_format_args("mp4", q);
            assert!(args.join(" ").contains(needle), "quality {q}");
        }
        assert!(build_format_args("mp3", "best").contains(&"-x".to_string()));
    }

    #[test]
    fn url_validation_rejects_non_http() {
        assert!(validate_url("").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("nota url").is_err());
        assert!(validate_url("https://example.com/v").is_ok());
        assert!(validate_url("HTTP://example.com/v").is_ok());
        assert!(validate_url(&"x".repeat(3000)).is_err());
    }

    #[test]
    fn output_dir_rejects_traversal_and_files() {
        assert!(validate_output_dir("").is_err());
        assert!(validate_output_dir("../evil").is_err());
        assert!(validate_output_dir("a/../../b").is_err());
        assert!(validate_output_dir("some/dir").is_ok());
    }

    #[test]
    fn template_requires_ext_and_no_paths() {
        assert!(validate_template(None).is_ok());
        assert!(validate_template(Some("".into())).is_ok());
        assert!(validate_template(Some("%(title)s.%(ext)s".into())).is_ok());
        assert!(validate_template(Some("%(title)s [%(id)s].%(ext)s".into())).is_ok());
        assert!(validate_template(Some("%(title)s.mp4".into())).is_err());
        assert!(validate_template(Some("../x.%(ext)s".into())).is_err());
        assert!(validate_template(Some("sub/dir.%(ext)s".into())).is_err());
        assert!(validate_template(Some("C:\\x.%(ext)s".into())).is_err());
    }
}
