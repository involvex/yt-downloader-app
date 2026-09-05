import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { upsertHistoryItem } from "../lib/store";
import {
  QUALITY_OPTIONS,
  type CompleteEventPayload,
  type DownloadItem,
  type ErrorEventPayload,
  type MediaFormat,
  type ProgressEventPayload,
  type Quality,
  type Settings,
} from "../lib/types";

interface MainViewProps {
  settings: Settings;
  initialUrl?: string;
  onHistoryChange: (items: DownloadItem[]) => void;
}

interface ActiveDownload {
  id: string;
  percent: number;
  speed?: string;
  eta?: string;
  raw: string;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function MainView({ settings, initialUrl, onHistoryChange }: MainViewProps) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [format, setFormat] = useState<MediaFormat>(settings.defaultFormat);
  const [quality, setQuality] = useState<Quality>(settings.quality);
  const [active, setActive] = useState<ActiveDownload | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unlistenRef = useRef<(() => void)[]>([]);

  // Note: no prop-syncing effects here. MainView unmounts on tab switch and
  // App remounts it via `key` when retrying a URL, so useState initializers
  // above always start from fresh props.
  useEffect(() => {
    const fns = unlistenRef.current;
    return () => {
      fns.forEach((fn) => {
        fn();
      });
    };
  }, []);

  function clearListeners() {
    unlistenRef.current.forEach((fn) => {
      fn();
    });
    unlistenRef.current = [];
  }

  async function startDownload() {
    const trimmed = url.trim();
    if (!trimmed || busy) return;
    clearListeners();
    setError(null);
    setDonePath(null);
    setBusy(true);

    const id = newId();
    setActive({ id, percent: 0, raw: "Starting…" });

    const base: DownloadItem = {
      id,
      url: trimmed,
      format,
      quality,
      status: "downloading",
      percent: 0,
      createdAt: Date.now(),
    };
    onHistoryChange(await upsertHistoryItem(base));

    const patchHistory = async (patch: Partial<DownloadItem>) => {
      onHistoryChange(await upsertHistoryItem({ ...base, ...patch }));
    };

    try {
      unlistenRef.current.push(
        await listen<ProgressEventPayload>("download-progress", (e) => {
          if (e.payload.id !== id) return;
          setActive({
            id,
            percent: e.payload.percent,
            speed: e.payload.speed ?? undefined,
            eta: e.payload.eta ?? undefined,
            raw: e.payload.raw,
          });
          void patchHistory({
            status: "downloading",
            percent: e.payload.percent,
            speed: e.payload.speed ?? undefined,
            eta: e.payload.eta ?? undefined,
          });
        })
      );
      unlistenRef.current.push(
        await listen<CompleteEventPayload>("download-complete", (e) => {
          if (e.payload.id !== id) return;
          setDonePath(e.payload.path);
          setActive((a) => (a ? { ...a, percent: 100 } : a));
          void patchHistory({
            status: "done",
            percent: 100,
            path: e.payload.path,
          });
        })
      );
      unlistenRef.current.push(
        await listen<ErrorEventPayload>("download-error", (e) => {
          if (e.payload.id !== id) return;
          setError(e.payload.message);
          void patchHistory({ status: "error", error: e.payload.message });
        })
      );

      const finalPath = await invoke<string>("download_media", {
        id,
        url: trimmed,
        format,
        quality,
        outputDir: settings.outputDir,
      });
      setDonePath(finalPath);
      setActive((a) => (a ? { ...a, percent: 100 } : a));
      await patchHistory({ status: "done", percent: 100, path: finalPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The backend already emitted download-error; only set what we know.
      setError((prev) => prev ?? message);
      await patchHistory({ status: "error", error: message });
    } finally {
      setBusy(false);
      clearListeners();
    }
  }

  const pct = active ? Math.min(100, Math.max(0, active.percent)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="url" className="mb-1 block text-xs font-medium text-zinc-400">
          Video / Audio URL
        </label>
        <input
          id="url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          placeholder="https://…"
          spellCheck={false}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-400">Format</span>
        <div className="flex rounded-lg border border-zinc-700 bg-zinc-900 p-0.5">
          {(["mp4", "mp3"] as MediaFormat[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                format === f ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f === "mp4" ? "Video (MP4)" : "Audio (MP3)"}
            </button>
          ))}
        </div>
        <select
          value={quality}
          onChange={(e) => setQuality(e.currentTarget.value as Quality)}
          disabled={format === "mp3"}
          title="Download quality"
          className="ml-auto rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none disabled:opacity-40"
        >
          {QUALITY_OPTIONS.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={startDownload}
        disabled={!url.trim() || busy}
        className="rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-opacity hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Downloading…" : "Download"}
      </button>

      {active && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-xs text-zinc-400">
              {[active.speed, active.eta ? `ETA ${active.eta}` : null]
                .filter(Boolean)
                .join(" · ") || "Working…"}
            </span>
            <span className="font-mono text-sm font-semibold text-zinc-100">{pct.toFixed(1)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-zinc-100 transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 truncate font-mono text-[11px] text-zinc-500">{active.raw}</p>
        </div>
      )}

      {donePath && !error && (
        <div className="rounded-lg border border-emerald-900 bg-emerald-950/40 p-3 text-xs text-emerald-200">
          <p className="font-semibold">Download complete</p>
          <p className="mt-1 break-all font-mono text-[11px]">{donePath}</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
          <p className="font-semibold">Download failed</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-red-300">Show details</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
              {error}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
