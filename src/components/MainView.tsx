import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { upsertHistoryItem } from "../lib/store";
import {
  FORMAT_OPTIONS,
  PLAYLIST_OPTIONS,
  QUALITY_OPTIONS,
  formatDuration,
  isVideoFormat,
  type CompleteEventPayload,
  type DownloadItem,
  type ErrorEventPayload,
  type MediaFormat,
  type PlaylistMode,
  type ProgressEventPayload,
  type Quality,
  type Settings,
  type VideoMetadata,
} from "../lib/types";

const MAX_CONCURRENT = 3;
const HISTORY_PERSIST_THROTTLE_MS = 1000;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function extractHttpUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"']+/i);
  return m ? m[0] : null;
}

interface MainViewProps {
  settings: Settings;
  initialUrl?: string;
  onHistoryChange: (items: DownloadItem[]) => void;
}

interface ActiveDownload {
  id: string;
  url: string;
  format: MediaFormat;
  quality: Quality;
  percent: number;
  speed?: string;
  eta?: string;
  raw: string;
  status: "queued" | "downloading" | "done" | "error";
  donePath?: string;
  error?: string;
}

interface QueuedJob {
  id: string;
  url: string;
  format: MediaFormat;
  quality: Quality;
  playlist: PlaylistMode;
  subtitleLangs: string;
  embedSubs: boolean;
  sponsorblockRemove: string;
  splitChapters: boolean;
  embedChapters: boolean;
}

function MetaCard({ meta }: { meta: VideoMetadata }) {
  return (
    <div className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      {meta.thumbnail != null && meta.thumbnail !== "" && (
        <img
          src={meta.thumbnail}
          alt=""
          referrerPolicy="no-referrer"
          className="h-16 w-28 shrink-0 rounded-md object-cover"
        />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-zinc-100">{meta.title ?? "Untitled"}</p>
        <p className="mt-0.5 truncate text-[11px] text-zinc-400">
          {[meta.uploader, meta.duration != null ? formatDuration(meta.duration) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </div>
  );
}

export default function MainView({ settings, initialUrl, onHistoryChange }: MainViewProps) {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [format, setFormat] = useState<MediaFormat>(settings.defaultFormat);
  const [quality, setQuality] = useState<Quality>(settings.quality);
  const [playlist, setPlaylist] = useState<PlaylistMode>(settings.playlist);
  const [subtitleLangs, setSubtitleLangs] = useState(settings.subtitleLangs);
  const [embedSubs, setEmbedSubs] = useState(settings.embedSubs);
  const [sponsorblockRemove, setSponsorblockRemove] = useState(settings.sponsorblockRemove);
  const [splitChapters, setSplitChapters] = useState(settings.splitChapters);
  const [embedChapters, setEmbedChapters] = useState(settings.embedChapters);
  const [active, setActive] = useState<Record<string, ActiveDownload>>({});
  const [meta, setMeta] = useState<VideoMetadata | null>(null);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [clipHint, setClipHint] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const jobsRef = useRef(new Map<string, DownloadItem>());
  const queueRef = useRef<QueuedJob[]>([]);
  const runningRef = useRef(0);
  const lastPersistRef = useRef<Record<string, number>>({});
  const onHistoryChangeRef = useRef(onHistoryChange);
  const settingsRef = useRef(settings);
  const clipboardDoneRef = useRef(false);

  // Keep listener closures on latest props without re-subscribing.
  useEffect(() => {
    onHistoryChangeRef.current = onHistoryChange;
    settingsRef.current = settings;
  });

  // FEAT-006: clipboard auto-detect on mount + window focus (only when the
  // field is still empty so retry URLs are never clobbered).
  useEffect(() => {
    async function tryClipboard() {
      if (clipboardDoneRef.current) return;
      try {
        const text = await navigator.clipboard.readText();
        const found = extractHttpUrl(text ?? "");
        if (found) {
          setUrl((prev) => {
            if (prev.trim()) return prev;
            clipboardDoneRef.current = true;
            setClipHint(true);
            return found;
          });
        }
      } catch {
        // Clipboard access denied or unavailable — manual paste still works.
      }
    }
    void tryClipboard();
    function onFocus() {
      setUrl((prev) => {
        if (prev.trim() || clipboardDoneRef.current) return prev;
        void tryClipboard();
        return prev;
      });
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Global listeners (one set per mount) routed by payload id — enables the
  // FEAT-001 queue. History disk writes are throttled (FEAT-017).
  useEffect(() => {
    let off: (() => void)[] = [];
    (async () => {
      const persist = async (id: string, patch: Partial<DownloadItem>, force = false) => {
        const now = Date.now();
        const last = lastPersistRef.current[id] ?? 0;
        if (!force && now - last < HISTORY_PERSIST_THROTTLE_MS) return;
        lastPersistRef.current[id] = now;
        const base = jobsRef.current.get(id);
        if (!base) return;
        onHistoryChangeRef.current(await upsertHistoryItem({ ...base, ...patch }));
      };
      off = [
        await listen<ProgressEventPayload>("download-progress", (e) => {
          const p = e.payload;
          setActive((prev) => {
            const cur = prev[p.id];
            if (!cur) return prev;
            return {
              ...prev,
              [p.id]: {
                ...cur,
                status: "downloading",
                percent: p.percent,
                speed: p.speed ?? undefined,
                eta: p.eta ?? undefined,
                raw: p.raw,
              },
            };
          });
          void persist(p.id, {
            status: "downloading",
            percent: p.percent,
            speed: p.speed ?? undefined,
            eta: p.eta ?? undefined,
          });
        }),
        await listen<CompleteEventPayload>("download-complete", (e) => {
          const p = e.payload;
          setActive((prev) => {
            const cur = prev[p.id];
            if (!cur) return prev;
            return {
              ...prev,
              [p.id]: { ...cur, status: "done", percent: 100, donePath: p.path },
            };
          });
          void persist(p.id, { status: "done", percent: 100, path: p.path }, true);
        }),
        await listen<ErrorEventPayload>("download-error", (e) => {
          const p = e.payload;
          setActive((prev) => {
            const cur = prev[p.id];
            if (!cur) return prev;
            if (cur.status === "done") return prev;
            return { ...prev, [p.id]: { ...cur, status: "error", error: p.message } };
          });
          const cur = jobsRef.current.get(p.id);
          if (cur && cur.status !== "done") {
            void persist(p.id, { status: "error", error: p.message }, true);
          }
        }),
      ];
    })();
    return () => {
      off.forEach((fn) => {
        fn();
      });
    };
  }, []);

  function pump() {
    while (runningRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const job = queueRef.current.shift();
      if (!job) break;
      runningRef.current += 1;
      setActive((prev) => {
        const cur = prev[job.id];
        if (!cur) return prev;
        return { ...prev, [job.id]: { ...cur, status: "downloading", raw: "Starting…" } };
      });
      void runJob(job);
    }
  }

  async function runJob(job: QueuedJob) {
    const s = settingsRef.current;
    try {
      const finalPath = await invoke<string>("download_media", {
        id: job.id,
        url: job.url,
        format: job.format,
        quality: job.quality,
        outputDir: s.outputDir,
        playlist: job.playlist,
        filenameTemplate: s.filenameTemplate,
        subtitleLangs: job.subtitleLangs,
        embedSubs: job.embedSubs,
        sponsorblockRemove: job.sponsorblockRemove,
        splitChapters: job.splitChapters,
        embedChapters: job.embedChapters,
      });
      setActive((prev) => {
        const cur = prev[job.id];
        if (!cur || cur.status === "done") return prev;
        return { ...prev, [job.id]: { ...cur, status: "done", percent: 100, donePath: finalPath } };
      });
      const base = jobsRef.current.get(job.id);
      if (base && base.status !== "done") {
        const next = { ...base, status: "done" as const, percent: 100, path: finalPath };
        jobsRef.current.set(job.id, next);
        lastPersistRef.current[job.id] = Date.now();
        onHistoryChangeRef.current(await upsertHistoryItem(next));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cancelled = /cancelled/i.test(message);
      setActive((prev) => {
        const cur = prev[job.id];
        if (!cur || cur.status === "done") return prev;
        return {
          ...prev,
          [job.id]: { ...cur, status: "error", error: cancelled ? "Download cancelled." : message },
        };
      });
      const base = jobsRef.current.get(job.id);
      if (base && base.status !== "done") {
        const next = {
          ...base,
          status: "error" as const,
          error: cancelled ? "Download cancelled." : message,
        };
        jobsRef.current.set(job.id, next);
        lastPersistRef.current[job.id] = Date.now();
        onHistoryChangeRef.current(await upsertHistoryItem(next));
      }
    } finally {
      runningRef.current = Math.max(0, runningRef.current - 1);
      pump();
    }
  }

  async function startDownload() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setUrlError(null);
    setMetaError(null);

    if (!/^https?:\/\//i.test(trimmed)) {
      setUrlError("Enter a valid URL starting with http:// or https://");
      return;
    }
    if (!settings.outputDir.trim()) {
      setUrlError("Choose a download folder in Settings first.");
      return;
    }

    const id = newId();
    const base: DownloadItem = {
      id,
      url: trimmed,
      title: meta?.title ?? undefined,
      format,
      quality,
      status: runningRef.current < MAX_CONCURRENT ? "downloading" : "queued",
      percent: 0,
      createdAt: Date.now(),
    };
    jobsRef.current.set(id, base);
    onHistoryChangeRef.current(await upsertHistoryItem(base));
    setActive((prev) => ({
      ...prev,
      [id]: {
        id,
        url: trimmed,
        format,
        quality,
        percent: 0,
        raw: runningRef.current < MAX_CONCURRENT ? "Starting…" : "Queued…",
        status: runningRef.current < MAX_CONCURRENT ? "downloading" : "queued",
      },
    }));
    queueRef.current.push({
      id,
      url: trimmed,
      format,
      quality,
      playlist,
      subtitleLangs: isVideoFormat(format) ? subtitleLangs.trim() : "",
      embedSubs,
      sponsorblockRemove: sponsorblockRemove.trim(),
      splitChapters,
      embedChapters,
    });
    setUrl("");
    setMeta(null);
    pump();
  }

  async function cancelJob(id: string) {
    // Optimistic UI — the backend error event confirms it.
    setActive((prev) => {
      const cur = prev[id];
      if (!cur || cur.status === "done" || cur.status === "error") return prev;
      return { ...prev, [id]: { ...cur, status: "error", error: "Cancelling…" } };
    });
    try {
      await invoke("cancel_download", { id });
    } catch {
      // Already finished — the complete event wins; drop the optimistic mark.
      setActive((prev) => {
        const cur = prev[id];
        if (!cur || cur.status === "done") return prev;
        return prev;
      });
    }
  }

  function dismissJob(id: string) {
    setActive((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    jobsRef.current.delete(id);
  }

  async function fetchPreview() {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      setUrlError("Enter a valid URL starting with http:// or https://");
      return;
    }
    setMetaLoading(true);
    setMetaError(null);
    setMeta(null);
    try {
      const m = await invoke<VideoMetadata>("fetch_metadata", { url: trimmed });
      setMeta(m);
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : String(err));
    } finally {
      setMetaLoading(false);
    }
  }

  const items = Object.values(active).sort((a, b) => (a.id < b.id ? 1 : -1));
  const running = items.filter((i) => i.status === "downloading" || i.status === "queued").length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="url" className="mb-1 block text-xs font-medium text-zinc-400">
          Video / Audio URL {dragOver && <span className="text-sky-300">— drop to fill</span>}
        </label>
        <div className="flex gap-2">
          <input
            id="url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.currentTarget.value);
              if (urlError) setUrlError(null);
              if (clipHint) setClipHint(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void startDownload();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const text =
                e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
              const found = extractHttpUrl(text ?? "");
              if (found) {
                setUrl(found);
                setUrlError(null);
              }
            }}
            placeholder="https://… (paste, drop, or auto-filled from clipboard)"
            spellCheck={false}
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={async () => {
              try {
                const text = await navigator.clipboard.readText();
                const found = extractHttpUrl(text ?? "") ?? text;
                setUrl(found);
                if (urlError) setUrlError(null);
              } catch {
                // Clipboard access denied or unavailable.
              }
            }}
            className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-500"
          >
            Paste
          </button>
        </div>
        {clipHint && <p className="mt-1 text-[11px] text-zinc-500">Filled from clipboard.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="format" className="text-xs font-medium text-zinc-400">
          Format
        </label>
        <select
          id="format"
          value={format}
          onChange={(e) => setFormat(e.currentTarget.value as MediaFormat)}
          title="Download format"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none"
        >
          {FORMAT_OPTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={quality}
          onChange={(e) => setQuality(e.currentTarget.value as Quality)}
          disabled={!isVideoFormat(format)}
          title="Download quality"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none disabled:opacity-40"
        >
          {QUALITY_OPTIONS.map((q) => (
            <option key={q.value} value={q.value}>
              {q.label}
            </option>
          ))}
        </select>
        <select
          value={playlist}
          onChange={(e) => setPlaylist(e.currentTarget.value as PlaylistMode)}
          title="Playlist handling"
          className="ml-auto rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 outline-none"
        >
          {PLAYLIST_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {isVideoFormat(format) && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="subs" className="text-xs font-medium text-zinc-400">
            Subtitles
          </label>
          <input
            id="subs"
            type="text"
            value={subtitleLangs}
            onChange={(e) => setSubtitleLangs(e.currentTarget.value)}
            placeholder="en,de — empty = off"
            spellCheck={false}
            className="w-44 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={embedSubs}
              onChange={(e) => setEmbedSubs(e.currentTarget.checked)}
              disabled={subtitleLangs.trim() === ""}
              className="accent-zinc-100"
            />
            Embed in video
          </label>
        </div>
      )}

      {isVideoFormat(format) && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="sb" className="text-xs font-medium text-zinc-400">
            SponsorBlock
          </label>
          <input
            id="sb"
            type="text"
            value={sponsorblockRemove}
            onChange={(e) => setSponsorblockRemove(e.currentTarget.value)}
            placeholder="sponsor,selfpromo — empty = off"
            spellCheck={false}
            className="w-56 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={splitChapters}
              onChange={(e) => setSplitChapters(e.currentTarget.checked)}
              className="accent-zinc-100"
            />
            Split chapters
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={embedChapters}
              onChange={(e) => setEmbedChapters(e.currentTarget.checked)}
              className="accent-zinc-100"
            />
            Embed chapters
          </label>
        </div>
      )}

      {urlError && <p className="text-xs text-red-400">{urlError}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void startDownload()}
          disabled={!url.trim()}
          className="flex-1 rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-opacity hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running > 0 ? `Queue download (${running} active)` : "Download"}
        </button>
        <button
          type="button"
          onClick={() => void fetchPreview()}
          disabled={!url.trim() || metaLoading}
          title="Fetch title, uploader and duration without downloading"
          className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-zinc-200 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {metaLoading ? "Loading…" : "Preview"}
        </button>
      </div>

      {metaError && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
          <p className="font-semibold">Preview failed</p>
          <p className="mt-1 break-words">{metaError}</p>
        </div>
      )}
      {meta != null && <MetaCard meta={meta} />}

      {items.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Queue — up to {MAX_CONCURRENT} at once
          </p>
          {items.map((job) => {
            const pct = Math.min(100, Math.max(0, job.percent));
            const busy = job.status === "queued" || job.status === "downloading";
            return (
              <div key={job.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-zinc-400"
                    title={job.url}
                  >
                    {job.url}
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold text-zinc-100">
                    {job.status === "queued" ? "queued" : `${pct.toFixed(1)}%`}
                  </span>
                </div>
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-zinc-800"
                  role="progressbar"
                  aria-valuenow={Math.round(pct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-zinc-100 transition-[width]"
                    style={{ width: `${job.status === "queued" ? 0 : pct}%` }}
                  />
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                  {[job.speed, job.eta ? `ETA ${job.eta}` : null].filter(Boolean).join(" · ") ||
                    job.raw}
                </p>
                {job.status === "done" && job.donePath && (
                  <p className="mt-1 break-all font-mono text-[11px] text-emerald-300">
                    {job.donePath}
                  </p>
                )}
                {job.status === "error" && job.error && (
                  <p className="mt-1 break-words text-[11px] text-red-300">{job.error}</p>
                )}
                <div className="mt-2 flex gap-2">
                  {busy && (
                    <button
                      type="button"
                      onClick={() => void cancelJob(job.id)}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:border-red-500 hover:text-red-300"
                    >
                      Cancel
                    </button>
                  )}
                  {(job.status === "done" || job.status === "error") && (
                    <button
                      type="button"
                      onClick={() => dismissJob(job.id)}
                      className="rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-200"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
