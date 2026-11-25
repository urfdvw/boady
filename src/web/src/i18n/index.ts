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

/**
 * Translate a backend error: known codes have a resource, otherwise shown as-is.
 * Errors are "code: detail"; the detail (e.g. Claude's answer when identification
 * failed, or the two colliding file names) is kept after the translated text.
 */
export function translateError(lang: Lang, err: string): string {
  const i = err.indexOf(":");
  const code = (i < 0 ? err : err.slice(0, i)).trim();
  const detail = i < 0 ? "" : err.slice(i + 1).trim();
  const key = `err.${code}`;
  if (key in en) return detail ? `${translate(lang, key)} (${detail})` : translate(lang, key);
  return translate(lang, "common.error", { msg: err });
}

export type T = (key: Key, vars?: Record<string, string | number>) => string;

export const I18nContext = createContext<{ lang: Lang; t: T }>({
  lang: "en",
  t: (k, v) => translate("en", k, v),
});

export const useI18n = () => useContext(I18nContext);

/** Backend notices are "code: detail"; known codes are translated. */
export function translateNotice(lang: Lang, text: string): string {
  const m = text.match(/^([a-z_]+)(?::\s*([\s\S]*))?$/);
  if (!m || !(`notice.${m[1]}` in en)) return text;
  const rest = m[2] ?? "";
  if (m[1] === "pulled") {
    try {
      const r = JSON.parse(rest);
      return translate(lang, "notice.pulled", { added: r.added.length, modified: r.modified.length, deleted: r.deleted.length });
    } catch {
      return text;
    }
  }
  return translate(lang, `notice.${m[1]}`, { msg: rest });
}
