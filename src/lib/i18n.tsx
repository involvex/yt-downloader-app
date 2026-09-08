import { LocaleContext, useLocale } from "./i18n";

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const { locale, setLocale } = useLocale();
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}
