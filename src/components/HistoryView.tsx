import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { clearHistory, removeHistoryItem } from "../lib/store";
import { t, useLocale } from "../lib/i18n.ts";
import type { DownloadItem, DownloadStatus } from "../lib/types";

interface HistoryViewProps {
  items: DownloadItem[];
  onHistoryChange: (items: DownloadItem[]) => void;
  onRetry: (url: string) => void;
}

const STATUS_STYLES: Record<DownloadStatus, string> = {
  queued: "bg-zinc-800 text-zinc-300",
  downloading: "bg-sky-950 text-sky-300",
  done: "bg-emerald-950 text-emerald-300",
  error: "bg-red-950 text-red-300",
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

type StatusFilter = "all" | DownloadStatus;

export default function HistoryView({ items, onHistoryChange, onRetry }: HistoryViewProps) {
  const { locale } = useLocale();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const q = query.trim().toLowerCase();
  const filtered = items.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    if (!q) return true;
    return [item.title ?? "", item.url, item.path ?? "", item.error ?? ""].some((f) =>
      f.toLowerCase().includes(q)
    );
  });

  async function handleRemove(id: string) {
    onHistoryChange(await removeHistoryItem(id));
  }

  async function handleClear() {
    await clearHistory();
    onHistoryChange([]);
  }

  async function handleReveal(path: string | undefined) {
    if (!path) return;
    try {
      await revealItemInDir(path);
    } catch {
      // Ignore opener failures (e.g. file moved); path is still shown.
    }
  }

  async function handleDeleteFile(path: string) {
    if (!confirm(t(locale, "historyView.confirmDelete"))) return;
    try {
      await invoke("delete_downloaded_file", { path });
      await handleRemove(
        items.find((i) => i.path === path)?.id ?? items.find((i) => i.path === path)?.id ?? ""
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleExportJson() {
    const data = JSON.stringify(filtered, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportCsv() {
    const header = "id,title,url,format,quality,status,percent,speed,eta,path,error,createdAt\n";
    const rows = filtered
      .map(
        (item) =>
          `"${(item.title ?? "").replace(/"/g, '""')}","${item.url.replace(/"/g, '""')}",${item.format},${item.quality},${item.status},${item.percent},"${(item.speed ?? "").replace(/"/g, '""')}","${(item.eta ?? "").replace(/"/g, '""')}","${(item.path ?? "").replace(/"/g, '""')}","${(item.error ?? "").replace(/"/g, '""')}",${item.createdAt}`
      )
      .join("\n");
    const blob = new Blob([header + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center">
        <p className="text-sm text-zinc-400">{t(locale, "historyView.noItems")}</p>
        <p className="mt-1 text-xs text-zinc-500">{t(locale, "historyView.noItemsHint")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="shrink-0 text-xs text-zinc-500">
          {t(locale, "historyView.itemsLabel", { n: filtered.length })}
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder={t(locale, "historyView.searchPlaceholder")}
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 outline-none focus:border-zinc-500"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.currentTarget.value as StatusFilter)}
          title={t(locale, "historyView.filterLabel")}
          className="shrink-0 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 outline-none"
        >
          {(["all", "queued", "downloading", "done", "error"] as StatusFilter[]).map((s) => (
            <option key={s} value={s}>
              {s === "all"
                ? t(locale, "historyView.filter.all")
                : t(locale, `mainView.status.${s}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={filtered.length === 0}
          title={t(locale, "historyView.exportCsv")}
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          CSV
        </button>
        <button
          type="button"
          onClick={handleExportJson}
          disabled={filtered.length === 0}
          title={t(locale, "historyView.exportJson")}
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          JSON
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        >
          {t(locale, "historyView.clearAll")}
        </button>
      </div>
      {filtered.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-center text-xs text-zinc-500">
          No items match the current search / filter.
        </p>
      )}
      {filtered.map((item) => (
        <div key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[item.status]}`}
            >
              {item.status}
            </span>
            <span className="text-[11px] text-zinc-500">
              {item.format.toUpperCase()} · {item.quality}
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-zinc-500">
              {formatDate(item.createdAt)}
            </span>
          </div>
          <p className="mt-2 truncate text-xs text-zinc-200" title={item.url}>
            {item.title ?? item.url}
          </p>
          {(item.status === "downloading" || item.status === "queued") && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-sky-400"
                style={{
                  width: `${Math.min(100, Math.max(0, item.percent))}%`,
                }}
              />
            </div>
          )}
          {item.path && (
            <p className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={item.path}>
              {item.path}
            </p>
          )}
          {item.error && (
            <details className="mt-1 text-[11px] text-red-300">
              <summary className="cursor-pointer">{t(locale, "mainView.errorDetails")}</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
                {item.error}
              </pre>
            </details>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onRetry(item.url)}
              className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] font-semibold text-zinc-200 hover:border-zinc-500"
            >
              {t(locale, "historyView.retry")}
            </button>
            {item.path && item.status === "done" && (
              <button
                type="button"
                onClick={() => void handleReveal(item.path)}
                className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                {t(locale, "historyView.showInFolder")}
              </button>
            )}
            {item.path && item.status === "done" && (
              <button
                type="button"
                onClick={() => void handleDeleteFile(item.path!)}
                className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 hover:border-red-500 hover:text-red-300"
              >
                Delete file
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleRemove(item.id)}
              className="ml-auto rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-red-300"
            >
              {t(locale, "historyView.remove")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
