/**
 * Window dragging for the borderless Neutralino shell.
 *
 * Electron honoured `-webkit-app-region: drag` from the stylesheet. WebView2 does not,
 * so the regions that the CSS marks as draggable are re-declared here and forwarded to
 * `window.beginDrag`, which starts the native move loop. Browsing the stylesheets at
 * runtime is not an option (the computed `-webkit-app-region` value is meaningless
 * outside Electron), so the selectors are listed once and kept in sync with the CSS.
 */
import { neutralino } from "./neutralino";

/** Rows the CSS marks `-webkit-app-region: drag`. */
const DRAG_REGIONS = [".topbar", ".window-titlebar", "[data-window-drag]"];
const DRAG_SELECTOR = DRAG_REGIONS.join(",");

/**
 * Interactive descendants inside a drag region. Matching at pointerdown time (instead
 * of a fixed exclusion list) keeps working when React replaces the children.
 */
const NO_DRAG_TARGETS = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  '[role="button"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  ".topbar__actions",
  ".sidebar-toggle",
  "[data-window-no-drag]",
].join(",");

const attached = new WeakSet<Element>();

function attach(el: Element): void {
  if (attached.has(el)) {
    return;
  }
  attached.add(el);
  el.addEventListener("pointerdown", (event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) {
      return;
    }
    const target = pointer.target;
    if (target instanceof Element && target.closest(NO_DRAG_TARGETS)) {
      return;
    }
    void neutralino()
      .window.beginDrag(pointer.screenX, pointer.screenY)
      .catch((error: unknown) => console.error("[window-drag] beginDrag failed", error));
    event.preventDefault();
  });
}

function scan(root: ParentNode): void {
  for (const selector of DRAG_REGIONS) {
    for (const el of root.querySelectorAll(selector)) {
      attach(el);
    }
  }
}

export function installWindowDrag(): () => void {
  scan(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          // Only the regions themselves, never every element React happens to mount.
          if (node.matches(DRAG_SELECTOR)) {
            attach(node);
          }
          scan(node);
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return () => observer.disconnect();
}
