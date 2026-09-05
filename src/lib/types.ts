export type MediaFormat = "mp4" | "mp3";

export type Quality = "best" | "1080p" | "720p" | "480p";

export type DownloadStatus = "queued" | "downloading" | "done" | "error";

export interface Settings {
  outputDir: string;
  quality: Quality;
  defaultFormat: MediaFormat;
}

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
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
];
