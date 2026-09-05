Kurzfassung: Dieser Plan beschreibt die Entwicklung einer nativen Windows 11 Desktop-App mit Tauri v2, Bun, React und Tailwind CSS. yt-dlp und ffmpeg werden als "Sidecars" direkt in die portable .exe kompiliert. Die App startet standardmäßig im Dark Mode.

1. Architektur & Tech-Stack

Frontend: React + TypeScript + Tailwind CSS (für das Dark Mode UI).
Backend: Rust (Tauri v2 Core).
Package Manager: Bun.
Storage: tauri-plugin-store (für Speicherung von Output-Pfad & Qualitäts-Settings).
Binaries: yt-dlp.exe und ffmpeg.exe werden über das Tauri externalBin Feature gebündelt.

2. Projekt-Setup

Initialisierung mit Bun:bunx create-tauri-app@latest downloader-app --manager bun --template react-ts
cd downloader-app
bun install

Tauri Plugins installieren:bun run tauri add store
bun run tauri add dialog

Tailwind CSS einrichten:bun add -d tailwindcss postcss autoprefixer
bunx tailwindcss init -p

Die tailwind.config.js so konfigurieren, dass der Dark Mode forciert wird (darkMode: 'class').

3. Sidecar Binaries (yt-dlp & ffmpeg) integrieren
   Tauri erfordert, dass gebündelte Binaries das Target-Triple im Dateinamen tragen. Für Windows 11 x64 ist das -x86_64-pc-windows-msvc.

Ordner erstellen: Im Root-Verzeichnis den Ordner src-tauri/binaries anlegen.
Binaries herunterladen & umbenennen:
yt-dlp.exe herunterladen und umbenennen in: yt-dlp-x86_64-pc-windows-msvc.exe
ffmpeg.exe herunterladen und umbenennen in: ffmpeg-x86_64-pc-windows-msvc.exe

Tauri Konfiguration (tauri.conf.json):"bundle": {
"externalBin": [
"binaries/yt-dlp",
"binaries/ffmpeg"
]
}

4. Rust Backend (Core Logik)
   Das Rust-Backend muss die Sidecars aufrufen und yt-dlp mitteilen, wo das gebündelte ffmpeg liegt.

Sidecar Command: Nutzung der tauri::process::Command::new_sidecar("yt-dlp") API.
FFmpeg Pfad auflösen: Über den AppHandle den Pfad zum gebündelten ffmpeg Sidecar ermitteln.
Argumente übergeben:
Für Video: -f bestvideo+bestaudio --merge-output-format mp4
Für Audio: -x --audio-format mp3
Generell: --ffmpeg-location <Pfad_zu_ffmpeg_sidecar>
Output: -o <Output_Pfad>/%(title)s.%(ext)s

Events: Den Download-Output (Stdout) parsen und als Tauri-Events ans Frontend senden, um einen Fortschrittsbalken zu animieren.

5. Frontend GUI (Dark Mode Default)
   Das UI wird minimalistisch in React gebaut, mit einem tiefdunklen Hintergrund (z. B. bg-gray-900 text-white).

Main Screen:
Ein Text-Input-Feld für die URL.
Ein Toggle/Checkbox (Video [MP4] vs. Audio [MP3]).
Ein primärer Download-Button.
Ein dezenter Fortschrittsbalken (erscheint bei aktivem Download).

Settings Screen (Modal/View):
Input mit Button (öffnet Tauri Dialog API), um den Standard-Speicherort festzulegen.
Dropdown für Standard-Qualität (z. B. Best, 1080p, 720p).
Laden/Speichern der Werte über das tauri-plugin-store.

6. Build Prozess
   Um am Ende die autarke, alleinstehende .exe zu generieren:
   bun run tauri build

Das Resultat liegt unter src-tauri/target/release/bundle/nsis/ (als Installer) und die rohe portable App unter src-tauri/target/release/downloader-app.exe.
Agent-Prompt
Kopiere den folgenden Prompt direkt in deinen AI-Coding-Agenten (z. B. Claude Code, Cursor oder Kilo CLI), um das Projekt generieren zu lassen:
Initialize a new Tauri v2 desktop application using Bun, React, TypeScript, and Tailwind CSS. The target OS is Windows 11.

Core Requirements:

1. UI: Create a minimal, modern GUI forced into Dark Mode by default.
2. Screens:
   - Main: URL input field, a clean toggle/checkbox for "Video (MP4)" vs "Audio (MP3)", and a "Download" button.
   - Settings: Directory picker (using tauri-plugin-dialog) for the output path, and a dropdown for default download quality. Persist these settings using tauri-plugin-store.
3. Binaries: Configure Tauri 'externalBin' (sidecars) to bundle 'yt-dlp' and 'ffmpeg'. Assume the binaries are placed in 'src-tauri/binaries/' and suffixed with '-x86_64-pc-windows-msvc'.
4. Backend (Rust): Write a Tauri command to execute the 'yt-dlp' sidecar. Crucially, dynamically resolve the path to the bundled 'ffmpeg' sidecar and pass it to yt-dlp using the '--ffmpeg-location' argument. Stream stdout back to the frontend to show download progress.
5. Package Manager: Strictly use Bun for all Node/frontend dependency management and scripts.

Please output the exact CLI commands to initialize the project, the necessary updates to `tauri.conf.json`, the Rust implementation for `main.rs` to handle the sidecar execution, and the React frontend code for the Main and Settings views.
