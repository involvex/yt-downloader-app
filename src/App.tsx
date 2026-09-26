import { useEffect, useState } from "react";
import { Download, History, Settings as SettingsIcon } from "lucide-react";
import MainView from "./components/MainView";
import HistoryView from "./components/HistoryView";
import SettingsView from "./components/SettingsView";
import { loadHistory, loadSettings } from "./lib/store";
import { LocaleProvider } from "./lib/i18n.tsx";
import { t, useLocale } from "./lib/i18n.ts";
import type { DownloadItem, Settings } from "./lib/types";

type Tab = "main" | "history" | "settings";

const TABS: { id: Tab; key: string; icon: typeof Download }[] = [
  { id: "main", key: "tab.download", icon: Download },
  { id: "history", key: "tab.history", icon: History },
  { id: "settings", key: "tab.settings", icon: SettingsIcon },
];

function AppInner() {
  const { locale } = useLocale();
  const [tab, setTab] = useState<Tab>("main");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<DownloadItem[]>([]);
  const [retryUrl, setRetryUrl] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, h] = await Promise.all([loadSettings(), loadHistory()]);
        setSettings(s);
        setHistory(h);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  function handleRetry(url: string) {
    setRetryUrl(url);
    setTab("main");
  }

  return (
    <div className="dark flex min-h-full flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 px-4 pt-4">
        <h1 className="text-base font-bold tracking-tight">{t(locale, "headerTitle")}</h1>
        <nav className="mt-2 flex gap-1">
          {TABS.map((tabItem) => (
            <button
              key={tabItem.id}
              type="button"
              onClick={() => setTab(tabItem.id)}
              className={`flex items-center gap-1.5 rounded-t-lg px-4 py-2 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-zinc-400 ${
                tab === tabItem.id
                  ? "bg-zinc-900 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <tabItem.icon size={14} strokeWidth={2.5} aria-hidden />
              {t(locale, tabItem.key)}
              {tabItem.id === "history" && history.length > 0 && (
                <span className="ml-0.5 rounded-full bg-zinc-700/80 px-1.5 py-0.5 text-[10px] font-bold tabular-nums">
                  {history.length}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 bg-zinc-900/40 p-4">
        {loadError && (
          <div className="mb-3 rounded-lg border border-red-900 bg-red-950/40 p-3 text-xs text-red-200">
            {t(locale, "loadError")} {loadError}
          </div>
        )}
        {!settings ? (
          <p className="text-xs text-zinc-500">{t(locale, "loading")}</p>
        ) : (
          <>
            {tab === "main" && (
              <MainView
                key={retryUrl ?? "fresh"}
                settings={settings}
                initialUrl={retryUrl}
                onHistoryChange={setHistory}
              />
            )}
            {tab === "history" && (
              <HistoryView
                items={history}
                onHistoryChange={setHistory}
                onRetry={handleRetry}
                outputDir={settings.outputDir}
              />
            )}
            {tab === "settings" && <SettingsView settings={settings} onSave={setSettings} />}
          </>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <LocaleProvider>
      <AppInner />
    </LocaleProvider>
  );
}
