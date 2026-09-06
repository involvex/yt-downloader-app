import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { saveSettings } from "../lib/store";
import {
  FORMAT_OPTIONS,
  PLAYLIST_OPTIONS,
  QUALITY_OPTIONS,
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

export default function SettingsView({ settings, onSave }: SettingsViewProps) {
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
  const [versions, setVersions] = useState<SidecarVersions | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function pickDirectory() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: outputDir || undefined,
        title: "Choose download folder",
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
      setError("Output directory must not be empty.");
      return;
    }
    const template = filenameTemplate.trim() || "%(title)s.%(ext)s";
    if (!template.includes("%(ext)s")) {
      setError("Filename template must contain %(ext)s.");
      return;
    }
    if (/[\\/]/.test(template) || template.includes("..") || template.includes(":")) {
      setError("Filename template must be a bare filename (no paths, '..' or ':').");
      return;
    }
    const langs = subtitleLangs.trim();
    if (
      langs !== "" &&
      langs !== "all" &&
      !/^[A-Za-z][A-Za-z_-]{0,11}(,[A-Za-z][A-Za-z_-]{0,11})*$/.test(langs)
    ) {
      setError('Subtitle languages must be comma-separated codes like "en,de".');
      return;
    }
    const sb = sponsorblockRemove.trim();
    if (
      sb !== "" &&
      !/^(sponsor|intro|outro|preview|filler|interaction|music_offtopic|all)(,(sponsor|intro|outro|preview|filler|interaction|music_offtopic|all))*$/.test(
        sb
      )
    ) {
      setError("Unknown SponsorBlock category.");
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
    };
    await saveSettings(next);
    onSave(next);
    setSaved(true);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="outputDir" className="mb-1 block text-xs font-medium text-zinc-400">
          Download folder
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
            Open
          </button>
          <button
            type="button"
            onClick={pickDirectory}
            className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-semibold text-zinc-200 hover:border-zinc-500"
          >
            Browse…
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="template" className="mb-1 block text-xs font-medium text-zinc-400">
          Filename template
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
          Must contain %(ext)s. Windows-unsafe characters are sanitized automatically.
        </p>
      </div>

      <div>
        <label htmlFor="quality" className="mb-1 block text-xs font-medium text-zinc-400">
          Default quality
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
              {q.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="defaultFormat" className="mb-1 block text-xs font-medium text-zinc-400">
          Default format
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
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="playlist" className="mb-1 block text-xs font-medium text-zinc-400">
          Playlist handling
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
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="subLangs" className="mb-1 block text-xs font-medium text-zinc-400">
          Default subtitles (video only)
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
          placeholder="en,de — empty = off"
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
          Embed subtitles in video file
        </label>
      </div>

      <div>
        <label htmlFor="sb" className="mb-1 block text-xs font-medium text-zinc-400">
          SponsorBlock categories (video only)
        </label>
        <input
          id="sb"
          type="text"
          value={sponsorblockRemove}
          onChange={(e) => {
            setSponsorblockRemove(e.currentTarget.value);
            setSaved(false);
          }}
          placeholder="sponsor,selfpromo — empty = off"
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
            Split chapters
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
            Embed chapters
          </label>
        </div>
      </div>

      <button
        type="button"
        onClick={handleSave}
        className="rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white"
      >
        Save settings
      </button>

      {saved && <p className="text-xs text-emerald-400">Settings saved.</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      <p className="font-mono text-[11px] text-zinc-500">
        {versions
          ? `yt-dlp ${versions.ytdlp ?? "missing"} · ffmpeg ${versions.ffmpeg?.split(" ").slice(0, 3).join(" ") ?? "missing"}`
          : "Sidecar versions unavailable."}
      </p>
    </div>
  );
}
