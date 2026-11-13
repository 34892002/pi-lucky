/**
 * The two chords pi-gui's main process swallowed before the page ever saw them.
 *
 * Everything else in pi-gui's `before-input-event` handler (`getDesktopCommandFromShortcut`,
 * `getSidePanelTabCommand`, `isCloseFocusedSurfaceShortcut`) is *already* handled inside the
 * renderer by `src/app/use-desktop-commands.ts` — it shares the same table in
 * `contracts/ipc.ts`, and pi-gui double-delivered those chords too (the palette toggles
 * de-dupe the main/renderer pair with `createChordPairGate`).
 *
 * So this module must stay small: re-registering the shared table here would double-fire
 * every shortcut in the app. It only owns what main uniquely did on Windows:
 *
 *  - `Ctrl+O` — pick a workspace folder (the macOS menu item used `Command+O`).
 *  - `Ctrl+V` — paste a clipboard *image* when focus is outside an editor. pi-gui read the
 *    clipboard synchronously in main and forwarded the result as `clipboardImagePasted`;
 *    Neutralino reads it asynchronously, so the chord is claimed first and the image is
 *    pushed a tick later. Editors keep their own paste (composer `onPaste`, xterm), which is
 *    why anything inside a text field or the terminal is left alone.
 *
 * Deliberately absent (parity with pi-gui on Windows, which installed no menu there):
 * `Ctrl+W`-style window close, reload, zoom, DevTools. `Ctrl+W` inside a panel is handled by
 * the renderer's `closeFocusedSurface`; the app closes with the titlebar's close button.
 */
import { desktopIpc } from "../../contracts/ipc";

export interface AcceleratorHooks {
  readonly platform: string;
  /** Opens the native folder picker and applies the pick, exactly as the menu item did. */
  readonly pickWorkspace: () => void;
  /** Reads the clipboard; resolves to the `clipboardImagePasted` payload. */
  readonly readClipboardImage: () => Promise<unknown>;
  readonly emitPush: (channel: string, payload: unknown) => void;
}

/** Text fields and the terminal own `Ctrl+V`; the shell only fills the gap outside them. */
function ownsPaste(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest(
      'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [data-pi-terminal], .xterm',
    ),
  );
}

export function attachAccelerators(hooks: AcceleratorHooks): () => void {
  const usesMeta = hooks.platform === "darwin";

  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey) {
      return;
    }
    // Neutralino reports `darwin`; everything else uses Control, like the Electron build.
    const modifier = usesMeta
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!modifier) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "o") {
      event.preventDefault();
      event.stopPropagation();
      hooks.pickWorkspace();
      return;
    }
    if (key === "v") {
      if (ownsPaste(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void hooks
        .readClipboardImage()
        .then((payload) => hooks.emitPush(desktopIpc.clipboardImagePasted, payload))
        .catch((error: unknown) => {
          console.error("[accelerators] clipboard image read failed", error);
        });
      return;
    }
  };

  window.addEventListener("keydown", handler, true);
  return () => window.removeEventListener("keydown", handler, true);
}
