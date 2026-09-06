import { Store } from "@tauri-apps/plugin-store";
import { downloadDir } from "@tauri-apps/api/path";
import { DEFAULT_FILENAME_TEMPLATE, type DownloadItem, type Settings } from "./types";

const SETTINGS_FILE = "settings.json";
const HISTORY_FILE = "history.json";
const HISTORY_LIMIT = 100;

let settingsStore: Store | null = null;
let historyStore: Store | null = null;

async function getSettingsStore(): Promise<Store> {
  if (!settingsStore) {
    settingsStore = await Store.load(SETTINGS_FILE, { autoSave: true });
  }
  return settingsStore;
}

async function getHistoryStore(): Promise<Store> {
  if (!historyStore) {
    historyStore = await Store.load(HISTORY_FILE, { autoSave: true });
  }
  return historyStore;
}

export async function loadSettings(): Promise<Settings> {
  const store = await getSettingsStore();
  const fallbackDir = await downloadDir().catch(() => "");
  const outputDir = (await store.get<string>("outputDir").catch(() => null)) || fallbackDir;
  const quality = (await store.get<Settings["quality"]>("quality").catch(() => null)) || "best";
  const defaultFormat =
    (await store.get<Settings["defaultFormat"]>("defaultFormat").catch(() => null)) || "mp4";
  const filenameTemplate =
    (await store.get<string>("filenameTemplate").catch(() => null)) || DEFAULT_FILENAME_TEMPLATE;
  const playlist =
    (await store.get<Settings["playlist"]>("playlist").catch(() => null)) || "single";
  const subtitleLangs = (await store.get<string>("subtitleLangs").catch(() => null)) || "";
  const embedSubs = (await store.get<boolean>("embedSubs").catch(() => null)) ?? true;
  return {
    outputDir,
    quality,
    defaultFormat,
    filenameTemplate,
    playlist,
    subtitleLangs,
    embedSubs,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getSettingsStore();
  await store.set("outputDir", settings.outputDir);
  await store.set("quality", settings.quality);
  await store.set("defaultFormat", settings.defaultFormat);
  await store.set("filenameTemplate", settings.filenameTemplate);
  await store.set("playlist", settings.playlist);
  await store.set("subtitleLangs", settings.subtitleLangs);
  await store.set("embedSubs", settings.embedSubs);
  await store.save();
}

export async function loadHistory(): Promise<DownloadItem[]> {
  const store = await getHistoryStore();
  const items = (await store.get<DownloadItem[]>("items").catch(() => null)) ?? [];
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

export async function upsertHistoryItem(item: DownloadItem): Promise<DownloadItem[]> {
  const store = await getHistoryStore();
  const items = (await store.get<DownloadItem[]>("items").catch(() => null)) ?? [];
  const idx = items.findIndex((i) => i.id === item.id);
  const next = idx >= 0 ? items.map((i) => (i.id === item.id ? item : i)) : [item, ...items];
  const trimmed = next.sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_LIMIT);
  await store.set("items", trimmed);
  await store.save();
  return trimmed;
}

export async function removeHistoryItem(id: string): Promise<DownloadItem[]> {
  const store = await getHistoryStore();
  const items = (await store.get<DownloadItem[]>("items").catch(() => null)) ?? [];
  const next = items.filter((i) => i.id !== id);
  await store.set("items", next);
  await store.save();
  return [...next].sort((a, b) => b.createdAt - a.createdAt);
}

export async function clearHistory(): Promise<void> {
  const store = await getHistoryStore();
  await store.set("items", []);
  await store.save();
}
