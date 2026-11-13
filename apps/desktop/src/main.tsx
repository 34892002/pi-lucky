import React from "react";
import ReactDOM from "react-dom/client";
import { earlyModifierChords, getSidePanelTabCommand } from "../contracts/ipc";
import App from "./app/App";
import { RendererErrorBoundary } from "./app/desktop-recovery";
import { WindowFrame } from "./app/window-titlebar";
import { I18nProvider } from "./i18n";
import { applyLastTheme } from "./ui/active-theme";
import "./dev-reload-hook";
import "./styles.css";

window.addEventListener(
  "keydown",
  (event) => {
    // Control+digit on macOS selects a side panel tab, not a thread; main queues it.
    const platform = window.piApp?.platform ?? "linux";
    const chord = {
      meta: event.metaKey,
      control: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    };
    if (getSidePanelTabCommand(platform, chord)) return;
    earlyModifierChords.note({
      modifier: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      key: event.key,
      code: event.code,
    });
  },
  true,
);

applyLastTheme();

// WebView2 falls back to Chromium's own context menu ("Reload / Save as / Print / Inspect")
// wherever the app does not handle the event, which reads as a browser leaking through a
// desktop UI. pi-gui never had that menu, so suppress it app-wide; surfaces that want one
// (thread rows, workspaces) render their own from the `contextmenu` handler.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <WindowFrame api={window.piApp}>
        <RendererErrorBoundary
          onRelaunch={() => {
            window.piApp?.relaunchApplication()?.catch((error: unknown) => {
              console.error("[renderer] relaunchApplication failed", error);
            });
          }}
        >
          <App />
        </RendererErrorBoundary>
      </WindowFrame>
    </I18nProvider>
  </React.StrictMode>,
);
