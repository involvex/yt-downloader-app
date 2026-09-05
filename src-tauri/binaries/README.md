# Sidecar binaries

Tauri `externalBin` requires each bundled binary to carry the target triple
suffix. For Windows 11 x64 that is `-x86_64-pc-windows-msvc`.

Place the two files here (this folder is `src-tauri/binaries/`):

- `yt-dlp-x86_64-pc-windows-msvc.exe`
- `ffmpeg-x86_64-pc-windows-msvc.exe`

Sources:

- yt-dlp: https://github.com/yt-dlp/yt-dlp/releases
  (download `yt-dlp.exe`, rename as above)
- ffmpeg: https://www.gyan.dev/ffmpeg/builds/ (full build, `bin/ffmpeg.exe`)
  or https://github.com/BtbN/FFmpeg-Builds/releases
  (download, extract `ffmpeg.exe`, rename as above)

> `bun run tauri build` will fail until both files exist.
> `bun run tauri dev` works without them, but downloads will error
> with a detailed message telling you the binaries are missing.
