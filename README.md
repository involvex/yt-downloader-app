# yt-dlp Desktop

Windows 11 desktop app that downloads video (MP4) and audio (MP3) using bundled `yt-dlp` and `ffmpeg` sidecars. Built with Tauri v2, React, TypeScript, and Tailwind CSS. Forced dark mode UI.

## Screenshots

_No screenshots provided._

## Features

- Download videos as MP4 or audio as MP3
- Quality selection (Best, 1080p, 720p, 480p)
- Configurable default download folder and format
- Download history with retry, reveal-in-folder, and removal
- Real-time progress with speed and ETA
- Detailed error messages with collapsible stderr view

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9.2, Tailwind CSS v3, Vite 8
- **Backend**: Rust 2021, Tauri v2
- **Package Manager**: Bun
- **Sidecars**: `yt-dlp` + `ffmpeg` (bundled)

## Prerequisites

- Windows 11 x64
- Bun >= 1.3.0
- Rust (stable, 2021 edition)
- Sidecar binaries placed in `src-tauri/binaries/`:
  - `yt-dlp-x86_64-pc-windows-msvc.exe`
  - `ffmpeg-x86_64-pc-windows-msvc.exe`

## Build

```powershell
bun install
bun run build
bun run tauri build
```

## Development

```powershell
bun install
bun run dev
bun run tauri dev
```

## Project Structure

```
src/                        # React frontend
├── App.tsx                 # Tab shell (Download / History / Settings)
├── components/
│   ├── MainView.tsx        # URL input, format toggle, quality, progress
│   ├── HistoryView.tsx     # History list, retry, reveal, remove
│   └── SettingsView.tsx    # Output dir picker, quality, default format
└── lib/
    ├── types.ts            # Shared TypeScript types
    └── store.ts            # Store abstraction (settings + history)

src-tauri/
├── src/lib.rs              # download_media command, ffmpeg resolver, progress parsing
├── Cargo.toml              # Rust dependencies + release profile
├── tauri.conf.json         # Window config, externalBin sidecars, NSIS bundle
└── capabilities/default.json  # Least-privilege permissions
```

## Verification

1. `bun run build` — typecheck + lint + format + vite build
2. `cargo check` — Rust compile check (requires sidecar binaries present)
3. `bun run tauri build --debug` — debug bundle

## License

MIT
