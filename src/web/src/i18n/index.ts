import { createContext, useContext } from "react";
import en from "./en.json";
import zh from "./zh.json";

export const LANGUAGES = { en, zh } as const;
export type Lang = keyof typeof LANGUAGES;
export type Key = keyof typeof en;

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const table = LANGUAGES[lang] as Record<string, string>;
  let s = table[key] ?? (en as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translate a backend error: known codes have a resource, otherwise shown as-is. */
export function translateError(lang: Lang, err: string): string {
  const code = err.split(":")[0].trim();
  const key = `err.${code}`;
  if (key in en) return translate(lang, key);
  return translate(lang, "common.error", { msg: err });
}

export type T = (key: Key, vars?: Record<string, string | number>) => string;

export const I18nContext = createContext<{ lang: Lang; t: T }>({
  lang: "en",
  t: (k, v) => translate("en", k, v),
});

export const useI18n = () => useContext(I18nContext);
