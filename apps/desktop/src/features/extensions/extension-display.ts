import type {
  RuntimeExtensionRecord,
  RuntimeSourceScope,
} from "@pi-gui/session-driver/runtime-types";
import { translate, type MessageKey, type Translate } from "../../i18n";

/** Where an extension or skill was discovered, as a stable grouping key. */
export type ResourceGroupKey = "project" | "user" | "temporary" | "addons" | "pi-gui";

export function extensionSourceSummary(
  extension: RuntimeExtensionRecord,
  t: Translate = translate,
): string {
  return `${extensionScopeLabel(extension, t)} · ${extension.sourceInfo.origin}`;
}

/** Extensions pi-lucky itself adds to every session; switched on and off app-wide. */
export function isPiGuiBuiltinExtension(extension: RuntimeExtensionRecord): boolean {
  return (
    extension.sourceInfo.source === "builtin" &&
    extension.sourceInfo.origin === "top-level" &&
    extension.sourceInfo.scope === "temporary"
  );
}

/**
 * pi's own add-ons (MCP, code mode, tool search), named `builtin:<name>`. Their switch writes
 * pi's `extensions` setting, so terminal pi follows it too.
 */
export function isPiAddonExtension(extension: RuntimeExtensionRecord): boolean {
  return extension.sourceInfo.source === "builtin" && extension.path.startsWith("builtin:");
}

export function extensionScopeLabel(
  extension: RuntimeExtensionRecord,
  t: Translate = translate,
): string {
  if (isPiGuiBuiltinExtension(extension)) return t("extensions.group.piTools");
  if (isPiAddonExtension(extension)) return t("extensions.group.piAddons");
  return extension.sourceInfo.scope;
}

const GROUP_LABEL_KEYS: Readonly<Record<ResourceGroupKey, MessageKey>> = {
  project: "extensions.group.workspace",
  user: "extensions.group.user",
  temporary: "extensions.group.session",
  addons: "extensions.group.piAddons",
  "pi-gui": "extensions.group.piTools",
};

export function sourceScopeGroupKey(scope: RuntimeSourceScope): ResourceGroupKey {
  return scope;
}

/** Group heading for where a skill or extension was discovered. */
export function sourceScopeGroupLabel(
  scope: RuntimeSourceScope,
  t: Translate = translate,
): string {
  return groupLabel(sourceScopeGroupKey(scope), t);
}

export function extensionGroupKey(extension: RuntimeExtensionRecord): ResourceGroupKey {
  if (isPiGuiBuiltinExtension(extension)) return "pi-gui";
  if (isPiAddonExtension(extension)) return "addons";
  return sourceScopeGroupKey(extension.sourceInfo.scope);
}

export function groupLabel(key: ResourceGroupKey, t: Translate = translate): string {
  return t(GROUP_LABEL_KEYS[key]);
}

export function extensionGroupLabel(
  extension: RuntimeExtensionRecord,
  t: Translate = translate,
): string {
  return groupLabel(extensionGroupKey(extension), t);
}
