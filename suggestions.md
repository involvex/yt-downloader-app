# Feature Suggestions — yt-dlp-desktop (`downloader-app`)

> Generated 2026-09-06 from static analysis of `src/`, `src-tauri/src/lib.rs`,
> `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `package.json`.
> Stack: Tauri v2 + React 19 + TS 5.9.2 + Tailwind v3 + Bun, Windows 11 x64 only,
> single `download_media` command → `yt-dlp` sidecar + `ffmpeg` sidecar.
> No TODO/FIXME markers found — suggestions below are gap analysis vs. yt-dlp /
> downloader-app best practices.

## Feature Suggestions Report

### High Priority Suggestions

| ID       | Category | Description                                                          | Impact | Effort | Confidence |
| -------- | -------- | -------------------------------------------------------------------- | ------ | ------ | ---------- |
| FEAT-001 | Feature  | Download queue + concurrent downloads (replace single-`busy` lock)   | High   | Medium | 95%        |
| FEAT-002 | UX       | Cancel / kill running download (`shell:allow-kill` already granted)  | High   | Low    | 95%        |
| FEAT-003 | Feature  | Metadata preview before download (`--dump-single-json`)              | High   | Medium | 90%        |
| FEAT-004 | Feature  | Playlist support (toggle for `--no-playlist` + item picker)          | High   | Medium | 90%        |
| FEAT-005 | Update   | yt-dlp self-update check + version display (`--version`, `--update`) | High   | Low    | 92%        |
| FEAT-006 | UX       | Clipboard auto-detect + drag-drop URL + Enter-to-download hardening  | Medium | Low    | 90%        |
| FEAT-007 | Settings | Custom filename template + sanitize + subfolder per source           | High   | Low    | 88%        |

### Medium Priority Suggestions

| ID       | Category | Description                                                                      | Impact | Effort | Confidence |
| -------- | -------- | -------------------------------------------------------------------------------- | ------ | ------ | ---------- |
| FEAT-008 | Feature  | Subtitles / captions download (`--write-subs`, `--sub-langs`)                    | Medium | Low    | 90%        |
| FEAT-009 | Feature  | More formats: 4K/2K/1440p/2160p, 360p/240p, opus/m4a/wav/flac, best-audio        | Medium | Low    | 90%        |
| FEAT-010 | Feature  | SponsorBlock + chapter split (`--sponsorblock-remove`, `--split-chapters`)       | Medium | Low    | 85%        |
| FEAT-011 | Feature  | Auth-gated downloads: cookies-from-browser / cookies.txt + login hint            | Medium | Medium | 88%        |
| FEAT-012 | UX       | Retry with backoff + auto-retry on network error + resume (`-c`)                 | Medium | Low    | 85%        |
| FEAT-013 | History  | Search / filter / status filter + delete file from disk + export JSON/CSV        | Medium | Low    | 92%        |
| FEAT-014 | Settings | Bandwidth limit, proxy, concurrent-fragments, embed-thumbnail/metadata toggles   | Medium | Medium | 85%        |
| FEAT-015 | Security | Harden validation: URL allow-list, `output_dir` existence + traversal guard, CSP | High   | Low    | 93%        |
| FEAT-016 | UX       | System-tray + minimize-to-tray + completion notification + sound                 | Medium | Medium | 80%        |

### Low Priority Suggestions

| ID       | Category     | Description                                                                             | Impact | Effort | Confidence |
| -------- | ------------ | --------------------------------------------------------------------------------------- | ------ | ------ | ---------- |
| FEAT-017 | Optimization | Throttle progress events (e.g. emit at most 4–10 Hz, `requestAnimationFrame`)           | Low    | Low    | 85%        |
| FEAT-018 | DX           | Unit + e2e tests: Rust parser tests, Vitest for `store.ts`, WebDriverIO smoke           | Medium | Medium | 85%        |
| FEAT-019 | I18n/A11y    | EN/DE i18n, keyboard shortcuts, focus-visible, `aria-live` for progress                 | Low    | Medium | 80%        |
| FEAT-020 | Distribution | Auto-updater (`tauri-plugin-updater`), portable vs NSIS artifact naming, release script | Medium | Medium | 82%        |
| FEAT-021 | Maintenance  | Structured logging + `download-error` telemetry (local only) + log file rotation        | Low    | Medium | 78%        |

---

## Details

### FEAT-001 — Download queue + concurrent downloads

**File:** `src/components/MainView.tsx:44,68-81`, `src-tauri/src/lib.rs:123-261`
**Current:** Single `busy: boolean` + single `ActiveDownload | null`. `startDownload()` early-returns if `busy`, clears all listeners. Users cannot queue a second URL while one runs.
**Suggestion:** Replace `busy/active` with `Map<string, ActiveDownload>` keyed by `id`. Keep one global `listen()` set in `App.tsx` (not per-download), dispatch by `payload.id`. Add Rust-side semaphore (e.g. `max 3` concurrent `sidecar.spawn()`), or serialize with a FIFO queue + `queued` status (type already exists in `src/lib/types.ts:5` but never used).
**Why high:** Single-download lock is the #1 throughput complaint for a downloader; `DownloadStatus = "queued"` is dead code today.
**Sketch:**

```tsx
// App.tsx — listen once, route by id
useEffect(() => {
  const off = Promise.all([
    listen<ProgressEventPayload>("download-progress", (e) =>
      patchItem(e.payload.id, { percent: e.payload.percent })
    ),
    listen<CompleteEventPayload>("download-complete", (e) =>
      patchItem(e.payload.id, { status: "done" })
    ),
    listen<ErrorEventPayload>("download-error", (e) =>
      patchItem(e.payload.id, { status: "error" })
    ),
  ]);
  return () => {
    void off.then((fns) => fns.forEach((fn) => fn()));
  };
}, []);
```

### FEAT-002 — Cancel running download

**File:** `src-tauri/src/lib.rs:160-162`, `src/components/MainView.tsx:240-247`
**Current:** `let (mut rx, _child) = command.spawn()` — child handle is dropped, so cancel is impossible despite `shell:allow-kill` already in `capabilities/default.json:27`.
**Suggestion:** Keep `Child` in a `Mutex<HashMap<id, Child>>`, add `#[tauri::command] fn cancel_download(id: String)` calling `child.kill()`. Frontend: "Cancel" button next to progress bar, sets `status: "error"` with `error: "Cancelled by user"`. No new capability needed — justify reuse in commit message per `AGENTS.md §7.2`.

```rust
static CHILDREN: LazyLock<Mutex<HashMap<String, Child>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
#[tauri::command]
async fn cancel_download(id: String) -> Result<(), String> {
  if let Some(child) = CHILDREN.lock().unwrap().remove(&id) { child.kill().map_err(|e| e.to_string())?; }
  Ok(())
}
```

### FEAT-003 — Metadata preview (`title`, `thumbnail`, `duration`, formats)

**File:** `src/components/MainView.tsx:163-203`, `src-tauri/src/lib.rs:99-121`
**Current:** Blind download — no title/duration/size shown until `Destination:` line. `DownloadItem.title?` exists but is never populated.
**Suggestion:** New command `fetch_metadata(url) -> { title, uploader, duration, thumbnail, formats[] }` via `yt-dlp --dump-single-json --no-playlist --skip-download`. Show card with thumbnail + duration + format picker. Cache by URL in memory. Must keep arg-array style (no shell strings) per `AGENTS.md §5`.
**Pitfall:** JSON can be >1 MB for playlists — enforce `--no-playlist` first, paginate playlist variant separately (see FEAT-004).

### FEAT-004 — Playlist support

**File:** `src-tauri/src/lib.rs:147` (`--no-playlist` hardcoded)
**Current:** Playlists always collapsed to single video.
**Suggestion:** Settings toggle `playlist: "single" | "full" | "ask"`. When `full`, drop `--no-playlist`, parse `[download] Downloading video N of M` lines, emit `playlist-progress { id, index, total }`. Reuse FEAT-003 metadata to list items with checkboxes. Cap at e.g. 50 items with warning.

### FEAT-005 — yt-dlp version display + self-update

**File:** `src-tauri/binaries/README.md`, `src/components/SettingsView.tsx`
**Current:** No way to know bundled yt-dlp age; YouTube breakages require manual `.exe` swap.
**Suggestion:** `get_sidecar_versions()` command (`yt-dlp --version`, `ffmpeg -version` first line). Show in Settings footer. "Check for update" button shells `yt-dlp --update` note: sidecar is read-only in production bundle — correct flow is download new exe to `binaries/` at build time + in-app toast "a new app release with updated yt-dlp is available". Pair with FEAT-020 updater.

### FEAT-006 — Clipboard auto-detect + drag-drop

**File:** `src/components/MainView.tsx:187-202`
**Current:** Manual "Paste" button only; `readText()` silently swallows denial.
**Suggestion:** On mount + on window focus, `readText()` and prefill if `^https?://`. Add drag-drop (`drag-drop` event from `@tauri-apps/api/webview` — needs `core:webview:allow-*` capability, justify in commit). Validate YouTube/sharing domains, show inline hint instead of silent catch.

### FEAT-007 — Custom filename template + sanitize

**File:** `src-tauri/src/lib.rs:139-142`, `src/components/SettingsView.tsx:63-94`
**Current:** Fixed `-o <dir>/%(title)s.%(ext)s`. Long/CJK/emoji titles break on Windows (`MAX_PATH`, illegal chars).
**Suggestion:** Settings field `filenameTemplate` default `%(title)s [%(id)s].%(ext)s`, plus toggles `restrict-filenames`, `windows-filenames`, `trim-filenames 200`. Validate template contains `%(ext)s`; reject `..` / absolute segments. yt-dlp already sanitizes with those flags — just expose them.

```rust
args.push("--windows-filenames".into());
args.push("--trim-filenames".into()); args.push("200".into());
```

### FEAT-008 — Subtitles / captions

**File:** `src-tauri/src/lib.rs:99-121`
**Current:** No subtitle flags.
**Suggestion:** Format-aware checkbox: `--write-subs --write-auto-subs --sub-langs "en,de,original" --convert-subs srt --embed-subs` (video) . Small UI: multi-select of `en/de/*`. Keep in sync with `QUALITY_OPTIONS` pattern in `src/lib/types.ts`.

### FEAT-009 — Extended quality / format matrix

**File:** `src/lib/types.ts:3,47-52`, `src-tauri/src/lib.rs:108-113`
**Current:** `best/1080p/720p/480p` + `mp4/mp3` only.
**Suggestion:** Add `2160p/1440p/360p/240p/best-audio` + audio codec select (`mp3/m4a/opus/flac/wav`, `--audio-quality 0`). Both files + `build_format_args` must change atomically (contract rule `AGENTS.md §7.1`). Example selector: `bestvideo[height<=2160]+bestaudio/best[height<=2160]/best`.

### FEAT-010 — SponsorBlock + chapters

**Current:** No chapter/SponsorBlock flags.
**Suggestion:** Toggles: `--sponsorblock-remove sponsor,selfpromo` + `--split-chapters --embed-chapters`. MP3 path benefits most (podcast chapter split). One-line Rust change + two checkboxes.

### FEAT-011 — Auth / cookies for age-restricted / private videos

**Current:** No cookie support; private videos fail with opaque "Sign in to confirm" stderr.
**Suggestion:** Settings: `cookiesFromBrowser: none|chrome|firefox|edge` → `--cookies-from-browser <v>` (needs capability justification — reads browser profile, prompt user), or `cookies.txt` file picker → `--cookies <path>`. Detect `stderr` containing "confirm your age" and surface actionable hint + link to picker. Never persist cookies to `history.json`.

### FEAT-012 — Resume + auto-retry

**File:** `src-tauri/src/lib.rs:144-152`
**Current:** No `-c/--continue`, no `--retries`; any blip = full restart + `download-error`.
**Suggestion:** Always pass `--continue --retries 10 --fragment-retries 10 --retry-sleep "exp=1:5"`. Frontend: "Retry" already exists in `HistoryView.tsx:106-112` — extend to exponential backoff (1s/5s/30s) with attempt counter stored on `DownloadItem`.

### FEAT-013 — History: search / filter / disk delete / export

**File:** `src/components/HistoryView.tsx`, `src/lib/store.ts:7,50-59`
**Current:** Flat list, `HISTORY_LIMIT=100`, remove/clear only, `revealItemInDir` only.
**Suggestion:** Search input (URL/title/path substring), status filter chips (`all/done/error/downloading`), per-day groups, "Delete file too" checkbox (use `plugin-fs` `remove` — keep user-initiated per `AGENTS.md §7.2`), export `history.json` → CSV/JSON via dialog `save()`. Sort stays in `store.ts`, not render (per `AGENTS.md §7.3`).

### FEAT-014 — Power settings: speed limit, proxy, fragments, embeds

**Current:** None of yt-dlp's `--limit-rate`, `--proxy`, `--concurrent-fragments`, `--embed-thumbnail --embed-metadata` exposed.
**Suggestion:** Advanced section in `SettingsView`: rate limit (`500K/1M/unlimited`), proxy URL (validate `http(s)://|socks5://`), concurrent fragments (1–8), embed thumbnail/metadata toggles. Each maps 1:1 to an arg — low risk.

### FEAT-015 — Security hardening (do first, ship with any network-facing change)

**File:** `src/components/MainView.tsx:75-78`, `src/components/SettingsView.tsx:71-78`, `src-tauri/src/lib.rs:132-134`, `tauri.conf.json:24`
**Current:** Frontend-only `^https?://` check; Rust accepts any non-empty `url`; `output_dir` from text input is trusted; CSP `null`.
**Suggestion:**

1. Re-validate in Rust: reject non-`http(s)`, reject `file://`, cap length 2048.
2. Canonicalize `output_dir`, require `is_dir()`, reject `..` escapes; never let title become a path (already true — keep `-o <dir>/…`).
3. Set restrictive CSP when first remote image (thumbnail, FEAT-003) ships: `img-src 'self' data: https://i.ytimg.com; script-src 'self'; object-src 'none'`.
4. Keep arg-array spawning; add `clippy::pedantic`-style review for any new command.

### FEAT-016 — Tray + notifications

**File:** `src-tauri/tauri.conf.json:13-23`, `src-tauri/Cargo.toml`
**Current:** No tray, no background completion toast.
**Suggestion:** `tauri-plugin-notification` for "Download complete" + `tray-icon` with show/hide + pause-all. Requires new plugin registration in `Cargo.toml` + `lib.rs` + `capabilities/default.json` (follow `AGENTS.md §3.5` hang workaround: `bun add` JS side manually).

### FEAT-017 — Throttle progress re-renders

**File:** `src/components/MainView.tsx:102-117`, `src-tauri/src/lib.rs:189-206`
**Current:** Every `--newline` line → `emit` → `setActive` + `upsertHistoryItem` (disk write!) per percent tick. yt-dlp can emit >10/s; store write per tick wears SSD and janks UI.
**Suggestion:** Frontend: throttle `setActive` to ~4 Hz (`requestAnimationFrame` or timestamp guard); persist history at most 1 Hz + on complete/error. Rust: coalesce duplicate percents before `emit`.

### FEAT-018 — Tests (biggest maintainability gap)

**Current:** Zero tests (`bun run build` = typecheck+lint+format only; `cargo test` empty).
**Suggestion:**

1. Rust `#[cfg(test)]` for `build_format_args`, progress/speed/ETA regexes, `resolve_ffmpeg_dir` candidates.
2. Vitest for `store.ts` upsert/slice/sort + `HISTORY_LIMIT`.
3. WebDriverIO/Tauri-driver smoke: paste URL → mock sidecar → complete event. Gate in CI before `tauri build`.

### FEAT-019 — i18n + a11y + shortcuts

**Current:** Hardcoded English strings, no `aria-*`, no shortcuts (`Plan.md` was DE, UI is EN).
**Suggestion:** `react-i18next` with `en/de`, `aria-live="polite"` on progress %, `role="progressbar"` + `aria-valuenow`, `Ctrl+V` paste-and-download, `Esc` cancel (pairs with FEAT-002). Forced-dark stays (`darkMode: "class"`).

### FEAT-020 — Auto-updater + release hygiene

**File:** `package.json:18`, `tauri.conf.json:28-45`
**Current:** `build:exe` copies bundle via `scripts/copy-build.ts`; no updater, version `0.1.0`.
**Suggestion:** Add `tauri-plugin-updater` + GitHub Releases feed, sign with `TAURI_SIGNING_PRIVATE_KEY`. Document in commit whenever `externalBin` / `TARGET_TRIPLE` quartet changes (`AGENTS.md §7.1`).

### FEAT-021 — Local log file + error telemetry

**Current:** `stderr_buf` shown in `<details>` then discarded; history stores `error` string only.
**Suggestion:** Append per-download log to `<appData>/logs/<id>.log` with rotation (keep 20), link "Open log" from error `<details>`. Never exfiltrate — local only (per `AGENTS.md §7.2`).

---

## Suggested build order (3 milestones)

1. **Reliability first (1–2 days):** FEAT-015 + FEAT-002 + FEAT-012 + FEAT-007 — makes current single-download flow cancellable, resumable, safe.
2. **Delight (3–5 days):** FEAT-003 + FEAT-001 + FEAT-004 + FEAT-005 + FEAT-006 — preview → queue → playlists → staying current.
3. **Power + polish (1–2 weeks):** FEAT-008 → FEAT-014, FEAT-013, FEAT-017, FEAT-018, FEAT-020.

## Out of scope / explicitly not suggested

- Remote URL shortening / cloud upload / account sync — conflicts with local-only privacy posture (`AGENTS.md §7.2`).
- Arbitrary shell / custom yt-dlp flags textbox — reintroduces injection risk; prefer curated toggles.
- Light mode / theming engine — `Plan.md` mandates forced dark; Tailwind `darkMode: "class"` root pattern depends on it.
- macOS/Linux targets — triple quartet (`binaries/*-<triple>.exe`, `TARGET_TRIPLE`, `externalBin`, capabilities) is Win-x64-only by design.

---

## Verification for any suggestion above (per `AGENTS.md §7.4`)

1. `bun run build` (typecheck + lint + `format:check` + vite build) green.
2. `cargo check` in `src-tauri/` (needs sidecar `*.exe` per `binaries/README.md`).
3. `bun run tauri build --debug` for packaging/capability changes.
4. Manual: MP4 best + MP3 downloads show progress/speed/ETA, land in chosen dir, appear in History, survive restart.
