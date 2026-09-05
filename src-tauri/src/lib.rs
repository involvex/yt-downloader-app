use regex::Regex;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
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
        "1080p" => "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "720p" => "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        "480p" => "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
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
) -> Result<String, String> {
    if url.trim().is_empty() {
        return Err("URL must not be empty.".to_string());
    }

    let ffmpeg_dir = resolve_ffmpeg_dir(&app)?;
    let ffmpeg_location = ffmpeg_dir.to_string_lossy().to_string();

    let output_template = format!(
        "{}/%(title)s.%(ext)s",
        output_dir.trim_end_matches(['/', '\\'])
    );

    let mut args = build_format_args(&format, &quality);
    args.push("--newline".to_string());
    args.push("--progress".to_string());
    args.push("--no-playlist".to_string());
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

    let (mut rx, _child) = command
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp sidecar: {e}"))?;

    let progress_re =
        Regex::new(r"\[download\]\s+(\d+(?:\.\d+)?)%").expect("valid progress regex");
    let dest_re = Regex::new(r"\[download\]\s+Destination:\s+(.+)").expect("valid dest regex");
    let merge_re =
        Regex::new(r"\[(?:Merge|ExtractAudio)\][^\n]*Destination:\s+(.+)").expect("valid merge regex");
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
                        let speed = speed_re
                            .captures(line)
                            .map(|c| c[1].to_string());
                        let eta =
                            eta_re.captures(line).map(|c| c[1].to_string());
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
                let code = payload.code.unwrap_or(-1);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![download_media])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
