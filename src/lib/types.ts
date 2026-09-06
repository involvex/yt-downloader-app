export type MediaFormat = "mp4" | "mp3";

export type Quality = "best" | "2160p" | "1440p" | "1080p" | "720p" | "480p" | "360p";

export type DownloadStatus = "queued" | "downloading" | "done" | "error";

export type PlaylistMode = "single" | "full";

export interface Settings {
  outputDir: string;
  quality: Quality;
  defaultFormat: MediaFormat;
  filenameTemplate: string;
  playlist: PlaylistMode;
}

export const DEFAULT_FILENAME_TEMPLATE = "%(title)s [%(id)s].%(ext)s";

export interface DownloadItem {
  id: string;
  url: string;
  title?: string;
  format: MediaFormat;
  quality: Quality;
  status: DownloadStatus;
  percent: number;
  speed?: string;
  eta?: string;
  path?: string;
  error?: string;
  createdAt: number;
}

export interface VideoMetadata {
  id: string | null;
  title: string | null;
  uploader: string | null;
  duration: number | null;
  thumbnail: string | null;
  webpage_url: string | null;
}

export interface SidecarVersions {
  ytdlp: string | null;
  ffmpeg: string | null;
}

export interface ProgressEventPayload {
  id: string;
  percent: number;
  speed: string | null;
  eta: string | null;
  raw: string;
}

export interface CompleteEventPayload {
  id: string;
  path: string;
}

export interface ErrorEventPayload {
  id: string;
  message: string;
  stderr: string;
}

export const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: "best", label: "Best" },
  { value: "2160p", label: "2160p" },
  { value: "1440p", label: "1440p" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "360p", label: "360p" },
];

export const PLAYLIST_OPTIONS: { value: PlaylistMode; label: string }[] = [
  { value: "single", label: "Single video" },
  { value: "full", label: "Full playlist" },
];

export function formatDuration(totalSeconds: number | null): string | null {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
