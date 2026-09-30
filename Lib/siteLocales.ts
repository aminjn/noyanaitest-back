import AppConfig from "../Models/AppConfig";
import {
  defaultLocale,
  isLocale,
  Locale,
  locales,
  setSiteDefaultLocale,
} from "./locales";

export type SiteLocales = { default: Locale; enabled: Locale[] };

const TTL = 30_000;
let cache: { at: number; value: SiteLocales } | null = null;

// The super admin's language settings (2026-09): the site default and the
// languages served. The default is always enabled and listed first; every
// language is on until the admin saves a selection.
export const getSiteLocales = async (): Promise<SiteLocales> => {
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const config = await AppConfig.findOne({ singleton: "SINGLETON" })
    .select("enabledLocales defaultLocale")
    .lean();
  const def = isLocale(config?.defaultLocale) ? config.defaultLocale : defaultLocale;
  const saved = Array.isArray(config?.enabledLocales)
    ? config.enabledLocales.filter(isLocale)
    : null;
  const enabled = saved && saved.length ? saved : [...locales];
  const value: SiteLocales = {
    default: def,
    enabled: [def, ...locales.filter((l) => l !== def && enabled.includes(l))],
  };
  cache = { at: Date.now(), value };
  setSiteDefaultLocale(def);
  return value;
};

export const clearSiteLocalesCache = () => {
  cache = null;
};

// keeps Lib/locales.ts's synchronous fallback current
export const startSiteLocalesRefresh = () => {
  const refresh = () => getSiteLocales().catch(() => {});
  void refresh();
  setInterval(refresh, TTL).unref?.();
};
