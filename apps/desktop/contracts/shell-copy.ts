/**
 * Copy the shell draws itself, named so both processes agree on it.
 *
 * Native dialogs are opened by the webview (Neutralino has no OS dialogs on the
 * sidecar side), but the sidecar is what decides *why* a dialog appears. Passing a
 * key instead of a finished sentence keeps the language the user chose while leaving
 * the sidecar free of a second copy of the catalog: the shell translates it with the
 * same `src/i18n/messages` every other surface reads.
 *
 * The union is checked against `MessageKey` where it is used (`src/host/shell-locale`),
 * so a key that never made it into the catalog fails `tsc`.
 */
export type ShellCopyKey =
  | "shell.openFolder"
  | "shell.openFiles"
  | "shell.openWorkspaceFolder"
  | "shell.attachFiles";
