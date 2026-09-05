# AGENTS.md — yt-dlp-desktop

> Instructions for AI coding agents working in this repo. Follow this file over
> generic defaults. Scope: whole repo (this folder — the canonical project root).
> Reference docs (no `CLAUDE.md` / `GEMINI.md` / `.github/copilot-instructions.md`
> exist — these are the sources of truth): `Plan.md`,
> `README.md` (template stub),
> `src-tauri/binaries/README.md` (sidecar setup),
> `package.json`, `src-tauri/tauri.conf.json`,
> `src-tauri/capabilities/default.json`.

Windows 11 desktop app (Tauri v2) that downloads video (MP4) / audio (MP3)
via a bundled `yt-dlp` sidecar + bundled `ffmpeg` sidecar. Forced dark mode UI.
Target: Windows 11 x64 only (`x86_64-pc-windows-msvc`).

---

## 1. Technologies

| Layer        | Tech (pinned where it matters)                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime      | [Tauri v2](https://v2.tauri.app/) (Rust core + WebView2 webview), Vite dev server on `http://localhost:1420`                          |
| Backend      | Rust 2021 edition, `tauri-build = 2`, `serde`/`serde_json`, `regex`, `uuid v4`                                                        |
| Frontend     | React 19 + `react-dom` 19, TypeScript **5.9.2 pinned** (see gotchas), Vite 8, `@vitejs/plugin-react` 6                                |
| Styling      | Tailwind CSS **v3** (`darkMode: "class"`, forced dark), `postcss` 8 — **no `autoprefixer`** (see gotchas)                             |
| Package mgr  | **Bun >= 1.3.0, always.** Never `npm`/`yarn`/`pnpm`.                                                                                  |
| IPC / events | `invoke("download_media")` → Rust; Rust → frontend events `download-progress` / `download-complete` / `download-error`                |
| Persistence  | `@tauri-apps/plugin-store` 2 (`settings.json`, `history.json`), `@tauri-apps/api/path` (`downloadDir()`)                              |
| OS APIs      | `@tauri-apps/plugin-dialog` 2 (directory picker), `@tauri-apps/plugin-opener` 2 (show-in-folder), `plugin-fs` 2                       |
| Sidecars     | `yt-dlp` + `ffmpeg` via `bundle.externalBin` + `app.shell().sidecar("yt-dlp")`, `tauri-plugin-shell` 2                                |
| Quality      | ESLint 9 flat config (`typescript-eslint` recommended + `react-hooks` v7 + `react-refresh`), Prettier + `prettier-plugin-tailwindcss` |

Tauri plugins registered in Rust (see `src-tauri/src/lib.rs`):
`opener`, `store`, `dialog`, `fs`, `shell`. If you add a plugin, register it in
both `Cargo.toml` **and** `lib.rs` **and** `capabilities/default.json`.

Shared contract: `src/lib/types.ts` (`MediaFormat`, `Quality`,
`DownloadItem`, `ProgressEventPayload`, `CompleteEventPayload`,
`ErrorEventPayload`, `QUALITY_OPTIONS`).

---

## 2. Repo layout

```text
downloader-app/                  # canonical project root (create-tauri-app, react-ts)
├── AGENTS.md                    # this file (authoritative agent guide)
├── Plan.md                      # original product plan (DE) + agent prompt
├── .gitignore                   # ignores sidecar *.exe, target/, node_modules/
├── package.json                 # bun scripts; prebuild gate = typecheck+lint+format:check
├── vite.config.ts               # fixed port 1420/strictPort, ignores src-tauri, TAURI_DEV_HOST HMR
├── tsconfig.json / tsconfig.node.json  # ES2020 + DOM, strict, noUnusedLocals/Params
├── eslint.config.js             # ignores dist + src-tauri
├── tailwind.config.js           # darkMode: "class", content: index.html + src/**/*
├── postcss.config.js            # tailwindcss only (no autoprefixer)
├── .prettierrc.json             # double quotes, semi, printWidth 100, tailwind plugin
├── src/
│   ├── App.tsx                  # tab shell (Download/History/Settings), loads settings+history
│   ├── main.tsx                 # entry
│   ├── index.css                # tailwind directives
│   ├── components/MainView.tsx      # URL input, MP4/MP3 toggle, quality, progress+speed/ETA, <details> errors
│   ├── components/HistoryView.tsx   # retry, show-in-folder (opener), remove/clear
│   ├── components/SettingsView.tsx  # dialog picker, quality + default format
│   └── lib/{store.ts,types.ts}  # store abstraction, shared types
└── src-tauri/
    ├── tauri.conf.json          # productName yt-dlp Desktop, 560x720 window, externalBin, NSIS
    ├── capabilities/default.json# least-privilege per-window perms (shell sidecar allow-list)
    ├── build.rs                 # tauri_build::build()
    ├── Cargo.toml               # see release profile below
    ├── src/lib.rs               # single command download_media + ffmpeg resolver + parsers
    ├── binaries/README.md + .gitkeep  # tracked; *.exe git-ignored, download per README
    └── icons/ gen/
```

`Plan.md` is historical — do not re-scaffold from it. `README.md`
is the unmodified `create-tauri-app` stub; ignore its IDE advice except
Tauri + rust-analyzer.

---

## 3. Useful Commands

All from the repo root unless noted. **PowerShell only** on Windows
(`Get-ChildItem`, `Remove-Item`, `Copy-Item`, `Move-Item` — never `rm -rf` /
`ls -la` / `cp` / `mv`). Never `cd` in chained commands — pass `workdir`
instead (or one `Set-Location` per call).

### 3.1 Install / dev loop (Bun only)

```powershell
bun install                  # install frontend deps
bun run dev                  # Vite dev server (port 1420)
bun run tauri dev            # full Tauri dev (Vite + Rust). Works WITHOUT sidecars (downloads error with helpful msg)
bun run preview              # preview production vite build
```

### 3.2 Quality gates — `bun run build` runs `prebuild` first, keep green

```powershell
bun run typecheck             # tsc --noEmit (src only per tsconfig include)
bun run lint                  # eslint .  (ignores dist, src-tauri)
bun run lint:fix              # eslint . --fix
bun run format                # prettier --write . (sorts Tailwind classes via plugin)
bun run format:check          # prettier --check . (CI gate)
bun run build                 # = prebuild (typecheck && lint && format:check) + vite build
```

### 3.3 Rust / Tauri bundle

```powershell
cargo check                   # in src-tauri/ — FAILS if sidecar *.exe missing (build-script externalBin check)
bun run tauri build --debug   # debug MSI + NSIS under $env:CARGO_TARGET_DIR (this machine: I:\dev\cargo-target)
bun run tauri build           # release bundle (profile: lto=true, codegen-units=1, opt-level=3, panic=abort, strip=true)
```

### 3.4 Sidecar smoke tests

```powershell
.\src-tauri\binaries\yt-dlp-x86_64-pc-windows-msvc.exe --version
.\src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe -version
```

### 3.5 Adding a Tauri plugin (known hang workaround)

`bun run tauri add <name>` runs an npm-install step that can hang past shell
timeouts **even though Cargo + capability edits already applied**. If it hangs:

```powershell
bun add @tauri-apps/plugin-<name>   # finish the JS side manually
# then hand-edit src-tauri/Cargo.toml + src-tauri/capabilities/default.json + src-tauri/src/lib.rs
cargo check                          # verify
```

---

## 4. Sidecar binaries (required for any Rust compile / bundle)

- Location: `src-tauri/binaries/`, triple-suffixed for Win x64:
  - `yt-dlp-x86_64-pc-windows-msvc.exe` — <https://github.com/yt-dlp/yt-dlp/releases>
  - `ffmpeg-x86_64-pc-windows-msvc.exe` — <https://github.com/BtbN/FFmpeg-Builds/releases>
    or <https://www.gyan.dev/ffmpeg/builds/> (`bin/ffmpeg.exe`), renamed as above.
- `*.exe` (~160 MB) are **git-ignored** (root `.gitignore`); only `.gitkeep` +
  `README.md` are tracked. Download + rename per `binaries/README.md` before building.
- `tauri.conf.json → bundle.externalBin: ["binaries/yt-dlp", "binaries/ffmpeg"]`
  (no triple, no extension in config — Tauri appends it). Build script validates
  at compile time: `cargo check` / `tauri build` **fail** without the files.
- `tauri dev` runs without them; downloads fail at runtime with a detailed message.

---

## 5. Backend conventions (`src-tauri/src/lib.rs`)

Single command signature — do not rename without updating frontend + types:

```rust
download_media(id: String, url: String, format: String, quality: String, output_dir: String)
```

- Spawn with `app.shell().sidecar("yt-dlp")` — **filename only**, never the
  `binaries/…` path or the triple-suffixed name. Pass args as an **array**
  (`Command::args(&[...])`), never a shell string (injection).
- ffmpeg resolution: probe `resource_dir()` candidates (`binaries/ffmpeg-<triple>.exe`,
  `binaries/ffmpeg.exe`, bare names) + dev fallback walking up from
  `current_exe()` (up to 6 levels) into `binaries/`. Pass its **parent dir** to
  yt-dlp `--ffmpeg-location` (yt-dlp accepts a directory). Return the full
  "not found … place in src-tauri/binaries/" message on failure.
- Quality map (keep in sync with `QUALITY_OPTIONS`):
  `best` → `bestvideo+bestaudio/best`; `1080p/720p/480p` →
  `bestvideo[height<=N]+bestaudio/best[height<=N]/best`; audio →
  `-x --audio-format mp3`. Video adds `--merge-output-format mp4`.
  Output template: `-o <output_dir>/%(title)s.%(ext)s`.
- Progress parsing with `regex`: `[download] 12.3%` → `download-progress`
  `{id, percent, speed?, eta?, raw}`; `Destination: <path>` → remember final path;
  speed/ETA from yt-dlp status line. Emit `download-complete {id, path}` on
  success, `download-error {id, message, stderr}` on failure — **return full
  stderr** so the frontend `<details>` shows actionable errors.
- Keep `TARGET_TRIPLE = "x86_64-pc-windows-msvc"` in sync with filenames and
  `tauri.conf.json`. `exe_extension()` handles `.exe` vs extensionless for
  future targets.
- Capabilities: sidecar spawn needs **both** `shell:allow-spawn` and
  `shell:allow-execute` entries with `{"name": "binaries/yt-dlp"|"binaries/ffmpeg",
"sidecar": true, "args": true}` + `shell:allow-kill` + `shell:allow-stdin-write`.
  Never broaden to `shell:allow-open` / unrestricted `shell:default`.

---

## 6. Frontend conventions (`src/`)

- `App.tsx`: tab shell only. Loads `loadSettings()` + `loadHistory()` in parallel
  on mount, shows `Loading…` until `settings != null`, surfaces load errors in a
  red banner. Retry flow: `HistoryView.onRetry(url)` → `setRetryUrl` + switch to
  `main` tab; `MainView` remounts via `key={retryUrl ?? "fresh"}`.
- **No prop-syncing `setState` in effects.** Remount via `key` / conditional render
  (tab unmount) instead — this is an ESLint-reviewed pattern (`react-hooks` v7).
- `MainView.tsx`: URL input + MP4/MP3 toggle + quality `<select>` (default from
  settings), `invoke("download_media", {id, url, format, quality, outputDir})`,
  `listen()` for the three download events filtered by `id`, progress bar + %
  - speed/ETA, error in collapsible `<details>` (message + stderr). Generates
    `id` per download (uuid) and calls `upsertHistoryItem`.
- `HistoryView.tsx`: sorted desc by `createdAt`, retry / `revealItemInDir`
  (plugin-opener) / remove / clear. Empty state when no items.
- `SettingsView.tsx`: directory picker via `plugin-dialog` `open({directory:true})`,
  quality + defaultFormat selects, explicit Save → `saveSettings` → `onSave`.
- `lib/store.ts`: sole Store access. Lazy singletons (`Store.load(..., {autoSave:true})`
  - explicit `save()` after every mutation). `loadSettings` falls back to OS
    `downloadDir()` and `"best"` / `"mp4"`. `HISTORY_LIMIT = 100` — enforce on upsert
    (sort desc, slice). Always `.catch(() => null)` on `store.get` (corrupt store
    must not crash load). Never import `Store` outside this file.
- Styling: Tailwind v3, forced dark — root containers carry `dark bg-zinc-950
text-zinc-100` (see `App.tsx`); `darkMode: "class"` in config. Run
  `bun run format` so `prettier-plugin-tailwindcss` sorts classes. No global CSS
  beyond `index.css` directives; no CSS-in-JS, no new UI deps without asking.
- Types: import from `./lib/types` / `../lib/types` only — no duplicated
  `Settings`/`DownloadItem`/payload interfaces. `tsconfig` has
  `noUnusedLocals` + `noUnusedParameters`: remove dead code instead of `_`-prefixing.

---

## 7. Best Practices and Guidelines

### 7.1 General / maintainability

- Prefer editing existing files; do not create new top-level docs (`*.md`) or
  new deps unless asked. Keep changes minimal and scoped (one concern per change).
- Keep the Rust↔TS contract in one place: `lib.rs` payload structs ↔
  `lib/types.ts`. Update both + both call sites in the same change.
- Keep the triple source-of-truth quartet in sync: `binaries/*-<triple>.exe`
  filenames, `TARGET_TRIPLE` in `lib.rs`, `bundle.externalBin` in
  `tauri.conf.json`, `capabilities/default.json` allow-list.
- History/settings logic lives in `lib/store.ts` only. Components call
  `load*/save*/upsert*/remove*/clear*` — no inline `Store.load`.
- `eslint.config.js` ignores `dist` and `src-tauri` — run `cargo clippy`/`cargo fmt --check`
  thinking for Rust instead (do not add Rust files to eslint).

### 7.2 Security (Tauri threat model: untrusted URLs → sidecar args → local files)

- **Least-privilege capabilities:** `windows: ["main"]` only; per-permission
  allow-lists. Justify any new capability entry in the PR/commit message.
- **No shell injection:** never build command strings; `sidecar()` + arg arrays
  only. Validate `url` is `http(s)://` before `invoke`; reject empty `output_dir`.
- **Path safety:** `output_dir` comes from the dialog picker or stored settings —
  never from pasted text without validation. Do not allow `..` traversal or
  writing outside the chosen dir; rely on yt-dlp `-o <dir>/%(title)s.%(ext)s`
  (never let the URL/title become a path).
- `tauri.conf.json → app.security.csp` is currently `null`. Do not load remote
  scripts/fonts; if you add any, set a restrictive CSP at the same time.
- No secrets/tokens in code, logs, history, or store files. Full `stderr` is shown
  to the user locally only — never exfiltrate it.
- `fs`/`dialog`/`opener` usage stays user-initiated (picker, reveal-in-folder).
  Do not add recursive-delete or arbitrary-write commands.

### 7.3 Performance

- Release profile is tuned (`lto`, `codegen-units=1`, `opt-level=3`,
  `panic=abort`, `strip`) — do not weaken it to speed up local builds; use
  `tauri build --debug` for iteration.
- Stream progress via events; never poll, never block the Rust command on full
  download buffering. Parse stdout line-wise (`CommandEvent::Stdout`).
- Frontend: filter events by `id`, clean up `listen()` unlisteners on unmount,
  avoid re-render storms (throttle progress state if needed). `Vite.watch.ignored:
**/src-tauri/**` is intentional — keep it.
- `history.json` capped at 100 items; keep sorts (`createdAt` desc) in
  `store.ts`, not in render.

### 7.4 Verification (Definition of Done)

1. `bun run build` — prebuild (typecheck + lint +
   format:check) + vite build, all green.
2. `cargo check` in `src-tauri/` (needs sidecars present) — clean.
3. `bun run tauri build --debug` for packaging changes (check MSI/NSIS under
   `$env:CARGO_TARGET_DIR`).
4. Manual: MP4 best + MP3 downloads show progress/speed/ETA, complete to the
   chosen dir, appear in History, survive restart; missing-sidecar dev run shows
   the detailed error.

---

## 8. Gotchas on this machine / repo

- **Bun only.** `bun run tauri …` proxies the Tauri CLI (`@tauri-apps/cli` is a
  devDependency). `npm`/`pnpm` will create lockfile drift — refuse.
- **PowerShell only.** `Remove-Item` / `Copy-Item` / `Get-ChildItem`, never
  `rm -rf` / `ls` / `cp`. Quote paths with spaces.
- `rust-analyzer` holds the shared cargo target-dir lock (`CARGO_TARGET_DIR=
I:\dev\cargo-target`) and slows `cargo` to a crawl — stop the IDE language
  server before long builds.
- `typescript` pinned to `5.9.2`: the v6 line ships without the ES2020 lib files
  this `tsconfig.json` targets — do not upgrade without migrating `target`/`lib`.
- No `autoprefixer`: its `caniuse-lite` dep dropped the `css-gradients` dataset
  the installed version requires; pointless for WebView2 (Chromium) anyway.
  `postcss.config.js` is intentionally tailwind-only.
- `tauri add` hang (see §3.5), `cargo check` failing = almost always missing
  sidecar `*.exe` (re-read `binaries/README.md`), `format:check` failing = run
  `bun run format` (class sorting counts).

---

## 9. Git hygiene

- Sidecars (`*.exe`/`.msi`/`.zip` in `src-tauri/binaries/`), `src-tauri/target/`, `dist/`,
  `node_modules/` are ignored — never force-add them (~160 MB).
- Commit messages: short imperative scope prefix (`frontend:`, `backend:`,
  `build:`, `docs:`). Mention capability/config changes explicitly.
- Before PR: `git status --short`, `git diff --stat`, and the §7.4 gates.
  Include manual download test evidence (format + quality + OS build).

<!--
Suggested next steps:
- Run bun run build to confirm gates are green
- Place sidecar exes per binaries/README.md and run cargo check
-->
