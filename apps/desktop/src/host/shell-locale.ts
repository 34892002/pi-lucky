/*
 * Shell-side copy: the few strings the Neutralino shell renders itself, before or
 * outside the React tree (native dialog titles, the startup failure panel, the
 * window title). The shell shares the renderer's origin and bundle, so it reads the
 * same locale preference the settings page writes and reuses the renderer catalogs
 * instead of carrying a second copy of the copy.
 */
import type { ShellCopyKey } from "../../contracts/shell-copy";
import { defaultLocale, matchSystemLocale, type AppLocale, type MessageKey } from "../i18n/catalog";
import { detectSystemLanguages, readStoredLocale } from "../i18n/preference";
import { translatorFor, type Translate } from "../i18n/translate";

/**
 * The keys a sidecar request may name, checked against the catalog: `never` here means
 * the copy is missing from `messages/en.ts`, so a typo or a forgotten translation of the
 * key set fails `tsc` instead of shipping an English dialog in a Chinese UI.
 */
const SHELL_COPY_KEYS: { readonly [K in ShellCopyKey]: K extends MessageKey ? K : never } = {
  "shell.openFolder": "shell.openFolder",
  "shell.openFiles": "shell.openFiles",
  "shell.openWorkspaceFolder": "shell.openWorkspaceFolder",
  "shell.attachFiles": "shell.attachFiles",
};

/**
 * The shell resolves its own translator because it can run before the React tree
 * mounts (a startup failure never gets one), and because no hook can be used here.
 */
export function shellTranslator(): Translate {
  const preference = readStoredLocale();
  if (preference !== "system") {
    return translatorFor(preference);
  }
  return translatorFor(systemLocale());
}

/** One shell string by name; the key union is what keeps both processes on the catalog. */
export function shellCopy(key: ShellCopyKey, t: Translate = shellTranslator()): string {
  return t(SHELL_COPY_KEYS[key]);
}

function systemLocale(): AppLocale {
  for (const tag of detectSystemLanguages()) {
    const match = matchSystemLocale(tag);
    if (match) {
      return match;
    }
  }
  return defaultLocale;
}
