/**
 * The app's own version, read from the single place that owns it.
 *
 * Electron exposed `app.getVersion()` (from package.json, baked into the bundle).
 * A Neutralino build has two version numbers — the shell's and the sidecar's — so
 * the packaged build stamps them from `neutralino.config.json` and the updater
 * compares against that.
 */
import { version as configuredVersion } from "../../../../neutralino.config.json";
import { appVersion } from "../env";

export const APP_VERSION: string = appVersion(configuredVersion);
