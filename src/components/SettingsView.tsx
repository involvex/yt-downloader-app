import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { check } from "@tauri-apps/plugin-updater";
import { saveSettings } from "../lib/store";
import { LOCALES, t, useLocale } from "../lib/i18n.ts";
import {
  FORMAT_OPTIONS,
  PLAYLIST_OPTIONS,
  QUALITY_OPTIONS,
  type Locale,
  type MediaFormat,
  type PlaylistMode,
  type Quality,
  type Settings,
  type SidecarVersions,
} from "../lib/types";

interface SettingsViewProps {
  settings: Settings;
  onSave: (settings: Settings) => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export default function SettingsView({ settings, onSave }: SettingsViewProps) {
  const { locale, setLocale } = useLocale();
  const [outputDir, setOutputDir] = useState(settings.outputDir);
  const [quality, setQuality] = useState<Quality>(settings.quality);
  const [defaultFormat, setDefaultFormat] = useState<MediaFormat>(settings.defaultFormat);
  const [filenameTemplate, setFilenameTemplate] = useState(settings.filenameTemplate);
  const [playlist, setPlaylist] = useState<PlaylistMode>(settings.playlist);
  const [subtitleLangs, setSubtitleLangs] = useState(settings.subtitleLangs);
  const [embedSubs, setEmbedSubs] = useState(settings.embedSubs);
  const [sponsorblockRemove, setSponsorblockRemove] = useState(settings.sponsorblockRemove);
  const [splitChapters, setSplitChapters] = useState(settings.splitChapters);
  const [embedChapters, setEmbedChapters] = useState(settings.embedChapters);
  const [localeDraft, setLocaleDraft] = useState<Locale>(settings.locale);
  const [versions, setVersions] = useState<SidecarVersions | null>(null);
  const [fresh, setFresh] = useState<{ latest: string; stale: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updaterState, setUpdaterState] = useState<
    "idle" | "checking" | "available" | "latest" | "error" | "installing" | "installed"
  >("idle");
  const [updaterVersion, setUpdaterVersion] = useState<string | null>(null);
  const [updaterError, setUpdaterError] = useState<string | null>(null);

  // FEAT-005: show bundled sidecar versions so a stale yt-dlp is visible.
  useEffect(() => {
    (async () => {
      try {
        setVersions(await invoke<SidecarVersions>("get_sidecar_versions"));
      } catch {
        // Sidecars missing in dev — versions stay hidden.
      }
    })();
  }, []);

  // Freshness check: compare the bundled yt-dlp date-version against the
  // latest GitHub release. Result cached 24h in localStorage; offline or
  // API failures stay silent.
  useEffect(() => {
    const bundled = versions?.ytdlp?.trim().replace(/^v/i, "");
    if (!bundled) return;
    (async () => {
      try {
        const cachedRaw = localStorage.getItem("ytdlp-latest");
        let tag = "";
        const cached = cachedRaw ? JSON.parse(cachedRaw) : null;
        if (cached && typeof cached.tag === "string" && Date.now() - cached.at < 24 * 3600 * 1000) {
          tag = cached.tag;
        } else {
          const res = await fetch("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest");
          if (!res.ok) return;
          const json = await res.json();
          tag = String(json.tag_name ?? "")
            .trim()
            .replace(/^v/i, "");
          if (!tag) return;
          localStorage.setItem("ytdlp-latest", JSON.stringify({ tag, at: Date.now() }));
        }
        if (tag && tag !== bundled) {
          setFresh({ latest: tag, stale: tag > bundled });
        }
      } catch {
        // Offline or rate-limited — skip the check quietly.
      }
    })();
  }, [versions]);

  async function pickDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: outputDir || undefined,
        title: t(locale, "settingsView.downloadFolderLabel"),
      });
      if (typeof selected === "string" && selected.length > 0) {
        setOutputDir(selected);
        setSaved(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openFolder() {
    if (!outputDir.trim()) return;
    try {
      await openPath(outputDir.trim());
    } catch {
      // Ignore opener failures.
    }
  }

  async function handleSave() {
    if (!outputDir.trim()) {
      setError(t(locale, "settingsView.error.noOutputDir"));
      return;
    }
    const template = filenameTemplate.trim() || "%(title)s.%(ext)s";
    if (!template.includes("%(ext)s")) {
      setError(t(locale, "settingsView.error.noExt"));
      return;
    }
    if (/[\\/]/.test(template) || template.includes("..") || template.includes(":")) {
      setError(t(locale, "settingsView.error.noPaths"));
      return;
    }
    const langs = subtitleLangs.trim();
    if (
      langs !== "" &&
      langs !== "all" &&
      !/^[A-Za-z][A-Za-z_-]{0,11}(,[A-Za-z][A-Za-z_-]{0,11})*$/.test(langs)
    ) {
      setError(t(locale, "settingsView.error.badLangs"));
      return;
    }
    const sb = sponsorblockRemove.trim();
    if (
      sb !== "" &&
      !/^(sponsor|intro|outro|preview|filler|interaction|music_offtopic|all)(,(sponsor|intro|outro|preview|filler|interaction|music_offtopic|all))*$/.test(
        sb
      )
    ) {
      setError(t(locale, "settingsView.error.badSponsorblock"));
      return;
    }
    setError(null);
    const next: Settings = {
      outputDir: outputDir.trim(),
      quality,
      defaultFormat,
      filenameTemplate: template,
      playlist,
      subtitleLangs: langs,
      embedSubs,
      sponsorblockRemove: sb,
      splitChapters,
      embedChapters,
      locale: localeDraft,
    };
    await saveSettings(next);
    setLocale(localeDraft);
    onSave(next);
    setSaved(true);
  }

  async function handleCheckForUpdates() {
    try {
      setUpdaterState("checking");
      const update = await check();
      if (update) {
        setUpdaterVersion(update.version);
        setUpdaterState("available");
      } else {
        setUpdaterState("latest");
      }
    } catch (e) {
      setUpdaterError(e instanceof Error ? e.message : String(e));
      setUpdaterState("error");
    }
  }

  async function handleInstallUpdate() {
    try {
      setUpdaterState("installing");
      const update = await check();
      if (update) {
        await update.install();
        setUpdaterState("installed");
      }
    } catch {
      // install() triggers a relaunch; the error is non-fatal.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Section title={t(locale, "settingsView.section.files")}>
        <div>
          <label htmlFor="outputDir" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.downloadFolderLabel")}
          </label>
          <div className="flex gap-2">
            <input
              id="outputDir"
              type="text"
              value={outputDir}
              onChange={(e) => {
                setOutputDir(e.currentTarget.value);
                setSaved(false);
              }}
              spellCheck={false}
              className="w-full truncate rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500"
            />
            <button
              type="button"
              onClick={openFolder}
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-500"
            >
              {t(locale, "settingsView.openButton")}
            </button>
            <button
              type="button"
              onClick={pickDirectory}
              className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-500"
            >
              {t(locale, "settingsView.browseButton")}
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="template" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.filenameTemplateLabel")}
          </label>
          <input
            id="template"
            type="text"
            value={filenameTemplate}
            onChange={(e) => {
              setFilenameTemplate(e.currentTarget.value);
              setSaved(false);
            }}
            spellCheck={false}
            placeholder="%(title)s [%(id)s].%(ext)s"
            className="w-full truncate rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
          <p className="mt-1 text-[11px] text-zinc-500">
            {t(locale, "settingsView.filenameTemplateHint")}
          </p>
        </div>
      </Section>

      <Section title={t(locale, "settingsView.section.defaults")}>
        <div>
          <label htmlFor="quality" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.defaultQualityLabel")}
          </label>
          <select
            id="quality"
            value={quality}
            onChange={(e) => {
              setQuality(e.currentTarget.value as Quality);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {QUALITY_OPTIONS.map((q) => (
              <option key={q.value} value={q.value}>
                {t(locale, `qualityOptions.${q.value}`)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="defaultFormat" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.defaultFormatLabel")}
          </label>
          <select
            id="defaultFormat"
            value={defaultFormat}
            onChange={(e) => {
              setDefaultFormat(e.currentTarget.value as MediaFormat);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {FORMAT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(locale, `formatOptions.${f.value}`)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="playlist" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.playlistLabel")}
          </label>
          <select
            id="playlist"
            value={playlist}
            onChange={(e) => {
              setPlaylist(e.currentTarget.value as PlaylistMode);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {PLAYLIST_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {t(locale, `playlistOptions.${p.value}`)}
              </option>
            ))}
          </select>
        </div>
      </Section>

      <Section title={t(locale, "settingsView.section.enrich")}>
        <div>
          <label htmlFor="subLangs" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.subtitlesLabel")}
          </label>
          <input
            id="subLangs"
            type="text"
            value={subtitleLangs}
            onChange={(e) => {
              setSubtitleLangs(e.currentTarget.value);
              setSaved(false);
            }}
            spellCheck={false}
            placeholder={t(locale, "mainView.subsPlaceholder")}
            className="w-full truncate rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
          <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={embedSubs}
              onChange={(e) => {
                setEmbedSubs(e.currentTarget.checked);
                setSaved(false);
              }}
              disabled={subtitleLangs.trim() === ""}
              className="accent-zinc-100"
            />
            {t(locale, "settingsView.embedSubtitles")}
          </label>
        </div>

        <div>
          <label htmlFor="sb" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.sponsorblockLabel")}
          </label>
          <input
            id="sb"
            type="text"
            value={sponsorblockRemove}
            onChange={(e) => {
              setSponsorblockRemove(e.currentTarget.value);
              setSaved(false);
            }}
            placeholder={t(locale, "mainView.sponsorblockPlaceholder")}
            spellCheck={false}
            className="w-full truncate rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500"
          />
          <div className="mt-2 flex flex-wrap gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={splitChapters}
                onChange={(e) => {
                  setSplitChapters(e.currentTarget.checked);
                  setSaved(false);
                }}
                className="accent-zinc-100"
              />
              {t(locale, "settingsView.splitChapters")}
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={embedChapters}
                onChange={(e) => {
                  setEmbedChapters(e.currentTarget.checked);
                  setSaved(false);
                }}
                className="accent-zinc-100"
              />
              {t(locale, "settingsView.embedChapters")}
            </label>
          </div>
        </div>
      </Section>

      <Section title={t(locale, "settingsView.section.app")}>
        <div>
          <label htmlFor="locale" className="mb-1 block text-xs font-medium text-zinc-400">
            {t(locale, "settingsView.languageLabel")}
          </label>
          <select
            id="locale"
            value={localeDraft}
            onChange={(e) => {
              setLocaleDraft(e.currentTarget.value as Locale);
              setSaved(false);
            }}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          >
            {(Object.keys(LOCALES) as Locale[]).map((l) => (
              <option key={l} value={l}>
                {t(locale, `settingsView.language.${l}`)}
              </option>
            ))}
          </select>
        </div>
      </Section>

      <Section title={t(locale, "settingsView.updater.title")}>
        <button
          type="button"
          onClick={handleCheckForUpdates}
          disabled={updaterState === "checking"}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {updaterState === "checking"
            ? t(locale, "settingsView.updater.checking")
            : t(locale, "settingsView.updater.check")}
        </button>
        {updaterState === "available" && updaterVersion && (
          <p
            role="status"
            className="rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-200"
          >
            {t(locale, "settingsView.updater.ready", {
              latest: updaterVersion,
              version: versions?.ytdlp ?? "?",
            })}
          </p>
        )}
        {updaterState === "latest" && (
          <p
            role="status"
            className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-2 text-xs text-zinc-400"
          >
            {t(locale, "settingsView.updater.latest", {
              version: versions?.ytdlp ?? "?",
            })}
          </p>
        )}
        {updaterState === "error" && (
          <p
            role="alert"
            className="rounded-lg border border-red-900 bg-red-950/30 p-2 text-xs text-red-200"
          >
            {t(locale, "settingsView.updater.error", {
              error: updaterError ?? "unknown",
            })}
          </p>
        )}
        {updaterState === "installing" && (
          <p
            role="status"
            className="rounded-lg border border-blue-900 bg-blue-950/30 p-2 text-xs text-blue-200"
          >
            {t(locale, "settingsView.updater.installing")}
          </p>
        )}
        {updaterState === "installed" && (
          <p
            role="status"
            className="rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-200"
          >
            {t(locale, "settingsView.updater.installed")}
          </p>
        )}
        {(updaterState === "available" || updaterState === "installed") && (
          <button
            type="button"
            onClick={handleInstallUpdate}
            disabled={["checking", "error", "installing"].includes(updaterState)}
            className="mt-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {t(locale, "settingsView.updater.installButton")}
          </button>
        )}
      </Section>

      <button
        type="button"
        onClick={handleSave}
        className="rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white"
      >
        {t(locale, "settingsView.saveButton")}
      </button>

      <div aria-live="polite">
        {saved && <p className="text-xs text-emerald-400">{t(locale, "settingsView.saved")}</p>}
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
      </div>

      <p className="font-mono text-[11px] text-zinc-500">
        {versions
          ? `${t(locale, "settingsView.sidecarYtdlp", { v: versions.ytdlp ?? t(locale, "settingsView.sidecarUnavailable") })} · ${t(locale, "settingsView.sidecarFfmpeg", { v: versions.ffmpeg?.split(" ").slice(0, 3).join(" ") ?? t(locale, "settingsView.sidecarUnavailable") })}`
          : t(locale, "settingsView.sidecarUnavailable")}
      </p>
      {fresh?.stale && (
        <p
          role="status"
          className="rounded-lg border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-200"
        >
          {t(locale, "settingsView.ytdlpStale", {
            bundled: versions?.ytdlp ?? "?",
            latest: fresh.latest,
          })}
        </p>
      )}
    </div>
  );
}
