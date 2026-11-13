/**
 * Typed access to the Neutralino runtime injected by `js/neutralino.js`.
 *
 * The client library is loaded as a classic script (it must be, to receive the
 * native bootstrap token), so it is a global — never a module import. `neutralino()`
 * fails loudly with a useful message instead of a `undefined is not an object` deep
 * inside a click handler.
 */
import type * as NeutralinoModule from "./neutralino";

export type NeutralinoApi = typeof import("./neutralino");
export type ClipboardImage = NeutralinoModule.ClipboardImage;
export type OpenDialogOptions = NeutralinoModule.OpenDialogOptions;
export type SpawnedProcess = NeutralinoModule.SpawnedProcess;
export type MessageBoxChoice = NeutralinoModule.MessageBoxChoice;
export type LogLevel = "INFO" | "WARNING" | "ERROR";

let cached: NeutralinoApi | undefined;

export function neutralino(): NeutralinoApi {
  if (cached) {
    return cached;
  }
  const api = (globalThis as { Neutralino?: NeutralinoApi }).Neutralino;
  if (!api) {
    throw new Error(
      "Neutralino runtime missing: load js/neutralino.js before the app bundle.",
    );
  }
  cached = api;
  return api;
}

export function hasNeutralino(): boolean {
  return Boolean((globalThis as { Neutralino?: NeutralinoApi }).Neutralino);
}
