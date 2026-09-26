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

/// Resolve the directory containing a usable `ffmpeg.exe` for yt-dlp's
/// `--ffmpeg-location` argument.
///
/// The bundled binary carries the target-triple suffix
/// (`ffmpeg-x86_64-pc-windows-msvc.exe`), but yt-dlp looks for a binary named
/// exactly `ffmpeg.exe` inside the given directory. We therefore:
/// 1. Probe the same candidate layouts as before.
/// 2. If we find the triple-suffixed binary but no plain `ffmpeg.exe` next to
///    it, copy it to `ffmpeg.exe` once (dev-mode binaries dir is writable;
///    packaged resource dirs may not be, in which case we fall back to
///    returning the full triple-suffixed path).
/// 3. Return the directory so `--ffmpeg-location` works with yt-dlp's normal
///    directory-based lookup.
///
/// Probes several candidate layouts because the bundle layout differs between
/// `tauri dev` (binaries live in `src-tauri/binaries/`) and a packaged build
/// (binaries live under the resource dir, with the target-triple suffix
/// stripped by Tauri at bundle time).
fn resolve_ffmpeg_path(app: &AppHandle) -> Result<String, String> {
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
            if let Some(parent) = candidate.parent() {
                let plain_path = parent.join(&plain);
                if !plain_path.exists() {
                    let _ = std::fs::copy(candidate, &plain_path);
                }
                // Always return the directory: yt-dlp `--ffmpeg-location`
                // expects a directory, never a file path.
                return parent
                    .to_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "ffmpeg directory path is not valid UTF-8.".to_string());
            }
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

/// FEAT-008: validate `--sub-langs` (comma-separated codes or `all`).
/// Empty/None disables subtitles. Rejects anything yt-dlp would interpret as
/// a flag or path — charset is limited to language-code characters.
fn validate_subtitle_langs(raw: Option<String>) -> Result<Option<String>, String> {
    let langs = raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let Some(langs) = langs else {
        return Ok(None);
    };
    if langs.len() > 64 {
        return Err("Subtitle languages are too long (max 64 characters).".to_string());
    }
    if langs == "all" {
        return Ok(Some(langs));
    }
    let ok = langs.split(',').filter(|p| !p.is_empty()).all(|p| {
        let p = p.strip_suffix(".*").unwrap_or(p);
        // Leading `-` would turn the value into a flag — reject it.
        !p.is_empty()
            && !p.starts_with('-')
            && p.len() <= 12
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    if !ok {
        return Err("Subtitle languages must be comma-separated codes like \"en,de\".".to_string());
    }
    Ok(Some(langs))
}

/// FEAT-008: subtitle args for video downloads. Audio (`-x`) extraction drops
/// subtitles — keep them video-only so failures can't break MP3 downloads.
fn build_subtitle_args(format: &str, langs: Option<&str>, embed: bool) -> Vec<String> {
    let Some(langs) = langs else {
        return Vec::new();
    };
    if format != "mp4" {
        return Vec::new();
    }
    let mut args = vec![
        "--write-subs".to_string(),
        "--write-auto-subs".to_string(),
        "--sub-langs".to_string(),
        langs.to_string(),
        "--convert-subs".to_string(),
        "srt".to_string(),
    ];
    if embed {
        args.push("--embed-subs".to_string());
    }
    args
}

/// FEAT-010: SponsorBlock categories yt-dlp understands. Values land verbatim
/// in `--sponsorblock-remove`, so only allow-listed names pass validation.
const SPONSOR_CATEGORIES: [&str; 9] = [
    "sponsor",
    "intro",
    "outro",
    "selfpromo",
    "preview",
    "filler",
    "interaction",
    "music_offtopic",
    "all",
];

/// FEAT-010: validate `--sponsorblock-remove` (comma-separated categories).
/// Empty/None disables SponsorBlock.
fn validate_sponsorblock(raw: Option<String>) -> Result<Option<String>, String> {
    let cats = raw
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let Some(cats) = cats else {
        return Ok(None);
    };
    if cats.len() > 64 {
        return Err("SponsorBlock categories are too long.".to_string());
    }
    let ok = cats
        .split(',')
        .filter(|p| !p.is_empty())
        .all(|p| SPONSOR_CATEGORIES.contains(&p));
    if !ok {
        return Err("Unknown SponsorBlock category.".to_string());
    }
    Ok(Some(cats))
}

/// FEAT-010: SponsorBlock removal plus chapter handling. Applies to video and
/// audio (podcasts benefit most from `--split-chapters`).
fn build_sponsorblock_args(
    categories: Option<&str>,
    split_chapters: bool,
    embed_chapters: bool,
) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(cats) = categories {
        args.push("--sponsorblock-remove".to_string());
        args.push(cats.to_string());
    }
    if split_chapters {
        args.push("--split-chapters".to_string());
    }
    if embed_chapters {
        args.push("--embed-chapters".to_string());
    }
    args
}

/// FEAT-009: audio codec allow-list. The codec lands verbatim in
/// `--audio-format`, so anything off-list is rejected (see `validate_format`).
const AUDIO_CODECS: [&str; 5] = ["mp3", "m4a", "opus", "flac", "wav"];

fn validate_format(raw: &str) -> Result<String, String> {
    let f = raw.trim().to_lowercase();
    if f == "mp4" || AUDIO_CODECS.contains(&f.as_str()) {
        Ok(f)
    } else {
        Err("Unsupported format.".to_string())
    }
}

/// Quality allow-list shared with the frontend `QUALITY_OPTIONS`.
/// Unknown values fall back to `best` so older settings never break a
/// download; empty input also means `best`.
fn validate_quality(raw: &str) -> String {
    match raw.trim() {
        "2160p" | "1440p" | "1080p" | "720p" | "480p" | "360p" | "240p" => {
            raw.trim().to_string()
        }
        _ => "best".to_string(),
    }
}

/// Cap buffered stderr so a verbose playlist failure can't bloat memory or
/// `history.json`. Keeps the tail (the actionable part).
fn push_stderr_capped(buf: &mut String, chunk: &str) {
    const MAX_STDERR: usize = 64 * 1024;
    buf.push_str(chunk);
    if buf.len() > MAX_STDERR {
        let tail = buf[buf.len() - MAX_STDERR..].to_string();
        // Cut at the first newline so we don't keep half a line.
        let cut = tail.find('\n').map(|i| i + 1).unwrap_or(0);
        *buf = tail[cut..].to_string();
    }
}

fn build_format_args(format: &str, quality: &str) -> Vec<String> {
    if format != "mp4" {
        // Validated by `validate_format`; fall back to mp3 defensively.
        let codec = if AUDIO_CODECS.contains(&format) {
            format
        } else {
            "mp3"
        };
        return vec![
            "-x".to_string(),
            "--audio-format".to_string(),
            codec.to_string(),
            "--audio-quality".to_string(),
            "0".to_string(),
        ];
    }

    let selector = match quality {
        "2160p" => "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best",
        "1440p" => "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best",
        "1080p" => "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
        "720p" => "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        "480p" => "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
        "360p" => "bestvideo[height<=360]+bestaudio/best[height<=360]/best",
        "240p" => "bestvideo[height<=240]+bestaudio/best[height<=240]/best",
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
    subtitle_langs: Option<String>,
    embed_subs: Option<bool>,
    sponsorblock_remove: Option<String>,
    split_chapters: Option<bool>,
    embed_chapters: Option<bool>,
) -> Result<String, String> {
    if id.trim().is_empty() || id.len() > 64 {
        return Err("Invalid download id.".to_string());
    }
    let url = validate_url(&url)?;
    let output_dir = validate_output_dir(&output_dir)?;
    let template = validate_template(filename_template)?;
    let subtitle_langs = validate_subtitle_langs(subtitle_langs)?;
    let format = validate_format(&format)?;
    let quality = validate_quality(&quality);
    let sponsorblock = validate_sponsorblock(sponsorblock_remove)?;

    let ffmpeg_path = resolve_ffmpeg_path(&app)?;

    let output_template = format!("{output_dir}/{template}");

    let mut args = build_format_args(&format, &quality);
    args.extend(build_subtitle_args(
        &format,
        subtitle_langs.as_deref(),
        embed_subs.unwrap_or(true),
    ));
    args.extend(build_sponsorblock_args(
        sponsorblock.as_deref(),
        split_chapters.unwrap_or(false),
        embed_chapters.unwrap_or(false),
    ));
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
    args.push("--extractor-args".to_string());
    args.push("youtube:player_client=android".to_string());
    args.push("--ffmpeg-location".to_string());
    args.push(ffmpeg_path);
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
    // Progress coalescing: yt-dlp can emit >10 lines/s; only forward when
    // the percent moved >= 0.5 or 250ms elapsed since the last emit.
    let mut last_emit_pct = -10.0f32;
    let mut last_emit_at = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap_or_else(std::time::Instant::now);

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
                        let now = std::time::Instant::now();
                        let pct_delta = (percent - last_emit_pct).abs();
                        if pct_delta >= 0.5
                            || now.duration_since(last_emit_at).as_millis() >= 250
                        {
                            last_emit_pct = percent;
                            last_emit_at = now;
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
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                push_stderr_capped(&mut stderr_buf, &text);
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

/// FEAT-013: delete a downloaded file from disk. User-initiated, path comes
/// from history (never from arbitrary pasted text). The path must resolve
/// inside the configured `output_dir` subtree — anything else is rejected.
#[tauri::command]
async fn delete_downloaded_file(
    _app: AppHandle,
    path: String,
    output_dir: Option<String>,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path must not be empty.".to_string());
    }
    let target = PathBuf::from(trimmed);
    let canonical_target = target
        .canonicalize()
        .map_err(|_| "File does not exist.".to_string())?;
    if !canonical_target.is_file() {
        return Err("Path is not a file.".to_string());
    }
    // Containment: the target must live inside the configured output dir.
    // The frontend always passes `settings.outputDir`; without it we refuse
    // rather than guess, so `invoke` can't become an arbitrary-delete primitive.
    let dir_raw = output_dir.unwrap_or_default();
    if dir_raw.trim().is_empty() {
        return Err("Output directory is required.".to_string());
    }
    let contained = match (
        PathBuf::from(dir_raw.trim()).canonicalize(),
        canonical_target.parent(),
    ) {
        (Ok(canon_dir), Some(parent)) => parent.starts_with(&canon_dir),
        _ => {
            let want = dir_raw.trim().replace('\\', "/").trim_end_matches('/').to_lowercase();
            match canonical_target.parent() {
                Some(parent) => {
                    let got = parent.to_string_lossy().replace('\\', "/").to_lowercase();
                    got == want || got.starts_with(&format!("{want}/"))
                }
                None => false,
            }
        }
    };
    if !contained {
        return Err("File is outside the download folder.".to_string());
    }
    std::fs::remove_file(&canonical_target).map_err(|e| format!("Failed to delete file: {e}"))
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
/// Results are cached in-memory for 10 minutes; the sidecar call times out
/// after 20s so a hung yt-dlp can't hang `invoke` forever.
fn metadata_cache() -> &'static Mutex<HashMap<String, (std::time::Instant, VideoMetadata)>> {
    static MAP: OnceLock<Mutex<HashMap<String, (std::time::Instant, VideoMetadata)>>> =
        OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
async fn fetch_metadata(app: AppHandle, url: String) -> Result<VideoMetadata, String> {
    let url = validate_url(&url)?;
    if let Ok(cache) = metadata_cache().lock() {
        if let Some((at, meta)) = cache.get(&url) {
            if at.elapsed().as_secs() < 600 {
                return Ok(meta.clone());
            }
        }
    }
    let fetch = async {
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
                if stdout.len() > 4 * 1024 * 1024 {
                    return Err("Video info is too large (playlist?).".to_string());
                }
            }
            CommandEvent::Stderr(line) => {
                push_stderr_capped(&mut stderr_buf, &String::from_utf8_lossy(&line));
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
    };
    let meta = match tokio::time::timeout(std::time::Duration::from_secs(20), fetch).await {
        Ok(r) => r?,
        Err(_) => return Err("Fetching video info timed out after 20s.".to_string()),
    };
    if let Ok(mut cache) = metadata_cache().lock() {
        cache.insert(url.clone(), (std::time::Instant::now(), meta.clone()));
        // Bound the cache so repeated previews can't grow memory forever.
        if cache.len() > 50 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest);
            }
        }
    }
    Ok(meta)
}

/// FEAT-005: show bundled sidecar versions in Settings so users can tell a
/// stale yt-dlp (the usual cause of sudden YouTube failures) apart.
/// Cached for 5 minutes; both sidecars are probed concurrently.
fn versions_cache() -> &'static Mutex<Option<(std::time::Instant, SidecarVersions)>> {
    static CELL: OnceLock<Mutex<Option<(std::time::Instant, SidecarVersions)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
async fn get_sidecar_versions(app: AppHandle) -> SidecarVersions {
    if let Ok(cache) = versions_cache().lock() {
        if let Some((at, v)) = cache.as_ref() {
            if at.elapsed().as_secs() < 300 {
                return v.clone();
            }
        }
    }
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

    let (ytdlp, ffmpeg) = tokio::join!(
        first_line(&app, "yt-dlp", &["--version"]),
        first_line(&app, "ffmpeg", &["-version"])
    );
    let versions = SidecarVersions { ytdlp, ffmpeg };
    if let Ok(mut cache) = versions_cache().lock() {
        *cache = Some((std::time::Instant::now(), versions.clone()));
    }
    versions
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            download_media,
            cancel_download,
            fetch_metadata,
            get_sidecar_versions,
            delete_downloaded_file
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
            ("240p", "height<=240"),
        ] {
            let args = build_format_args("mp4", q);
            assert!(args.join(" ").contains(needle), "quality {q}");
        }
        for codec in ["mp3", "m4a", "opus", "flac", "wav"] {
            let args = build_format_args(codec, "best");
            let joined = args.join(" ");
            assert!(joined.contains("-x"), "codec {codec}");
            assert!(
                joined.contains(&format!("--audio-format {codec}")),
                "codec {codec}"
            );
            assert!(joined.contains("--audio-quality 0"), "codec {codec}");
        }
    }

    #[test]
    fn sponsorblock_validation_and_args() {
        assert_eq!(validate_sponsorblock(None).unwrap(), None);
        assert_eq!(validate_sponsorblock(Some("".into())).unwrap(), None);
        assert_eq!(
            validate_sponsorblock(Some("sponsor,selfpromo".into())).unwrap(),
            Some("sponsor,selfpromo".to_string())
        );
        assert_eq!(
            validate_sponsorblock(Some("Sponsor".into())).unwrap(),
            Some("sponsor".to_string())
        );
        assert!(validate_sponsorblock(Some("--remove".into())).is_err());
        assert!(validate_sponsorblock(Some("sponsor,evil".into())).is_err());

        assert!(build_sponsorblock_args(None, false, false).is_empty());
        let args = build_sponsorblock_args(Some("sponsor"), true, true);
        let joined = args.join(" ");
        assert!(joined.contains("--sponsorblock-remove sponsor"));
        assert!(joined.contains("--split-chapters"));
        assert!(joined.contains("--embed-chapters"));
        assert!(!build_sponsorblock_args(None, true, false)
            .join(" ")
            .contains("--sponsorblock-remove"));
    }

    #[test]
    fn format_validation_allows_only_known() {
        assert_eq!(validate_format("mp4").unwrap(), "mp4");
        assert_eq!(validate_format("MP3").unwrap(), "mp3");
        assert_eq!(validate_format("opus").unwrap(), "opus");
        assert!(validate_format("").is_err());
        assert!(validate_format("avi").is_err());
        assert!(validate_format("mp3; rm -rf").is_err());
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
    fn subtitle_langs_validation() {
        assert_eq!(validate_subtitle_langs(None).unwrap(), None);
        assert_eq!(validate_subtitle_langs(Some("".into())).unwrap(), None);
        assert_eq!(
            validate_subtitle_langs(Some("en,de".into())).unwrap(),
            Some("en,de".to_string())
        );
        assert_eq!(
            validate_subtitle_langs(Some("all".into())).unwrap(),
            Some("all".to_string())
        );
        assert!(validate_subtitle_langs(Some("--write-subs".into())).is_err());
        assert!(validate_subtitle_langs(Some("../x".into())).is_err());
        assert!(validate_subtitle_langs(Some("en; rm".into())).is_err());
    }

    #[test]
    fn subtitle_args_video_only() {
        assert!(build_subtitle_args("mp4", None, true).is_empty());
        assert!(build_subtitle_args("mp3", Some("en"), true).is_empty());
        let args = build_subtitle_args("mp4", Some("en,de"), true);
        let joined = args.join(" ");
        assert!(joined.contains("--write-subs"));
        assert!(joined.contains("--write-auto-subs"));
        assert!(joined.contains("--sub-langs en,de"));
        assert!(joined.contains("--convert-subs srt"));
        assert!(joined.contains("--embed-subs"));
        let no_embed = build_subtitle_args("mp4", Some("en"), false);
        assert!(!no_embed.join(" ").contains("--embed-subs"));
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

    #[test]
    fn quality_validation_allows_only_known() {
        assert_eq!(validate_quality("best"), "best");
        assert_eq!(validate_quality("1080p"), "1080p");
        assert_eq!(validate_quality("240p"), "240p");
        assert_eq!(validate_quality(""), "best");
        assert_eq!(validate_quality(" 720p "), "720p");
        // Unknown values fall back to best so old settings never break.
        assert_eq!(validate_quality("8k"), "best");
        assert_eq!(validate_quality("mp3; rm -rf"), "best");
    }

    #[test]
    fn stderr_buffer_is_capped() {
        let mut buf = String::new();
        push_stderr_capped(&mut buf, &"x".repeat(70 * 1024));
        assert!(buf.len() <= 64 * 1024);
        // Keeps the tail (most recent, actionable output).
        push_stderr_capped(&mut buf, "TAIL-MARKER");
        assert!(buf.ends_with("TAIL-MARKER"));
    }

    #[test]
    fn progress_regex_matches_ytdlp_lines() {
        let progress_re =
            Regex::new(r"\[download\]\s+(\d+(?:\.\d+)?)%").expect("valid progress regex");
        let speed_re = Regex::new(r"at\s+(\S+/s)").expect("valid speed regex");
        let eta_re = Regex::new(r"ETA\s+(\S+)").expect("valid eta regex");
        let line = "[download]  12.3% of ~10.00MiB at 1.23MiB/s ETA 00:07";
        let cap = progress_re.captures(line).expect("progress matches");
        assert_eq!(&cap[1], "12.3");
        assert_eq!(
            speed_re.captures(line).map(|c| c[1].to_string()).as_deref(),
            Some("1.23MiB/s")
        );
        assert_eq!(
            eta_re.captures(line).map(|c| c[1].to_string()).as_deref(),
            Some("00:07")
        );
        assert!(progress_re.captures("[download] Downloading video 2 of 5").is_none());
    }
}
