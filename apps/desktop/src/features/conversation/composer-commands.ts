import { resolveRuntimeCommands } from "../../../contracts/composer-commands";
import type {
  RuntimeCommandRecord,
  RuntimeProviderRecord,
  RuntimeSettingsSnapshot,
  RuntimeSnapshot,
} from "@pi-gui/session-driver/runtime-types";
import type { ExtensionCommandCompatibilityRecord } from "../../../contracts/desktop-state";
import { titleCase } from "../../lib/string-utils";
import { translate, type MessageKey, type Translate } from "../../i18n";

export type ComposerSlashCommandKind =
  | "runtime"
  | "model"
  | "thinking"
  | "tree"
  | "status"
  | "session"
  | "reload"
  | "compact"
  | "name"
  | "login"
  | "logout"
  | "settings"
  | "scoped-models";

export interface ComposerSlashCommand {
  readonly id: string;
  readonly kind: ComposerSlashCommandKind;
  readonly command: string;
  readonly template: string;
  readonly title: string;
  readonly description: string;
  readonly submitMode?: "immediate" | "prefill" | "pick-option";
  readonly section: "runtime" | "host";
  readonly runtimeCommand?: RuntimeCommandRecord;
  readonly sourceLabel?: string;
  readonly compatibility?: ExtensionCommandCompatibilityRecord;
}

export interface ComposerSlashCommandSection {
  readonly id: "runtime" | "host";
  readonly title?: string;
  readonly items: readonly ComposerSlashCommand[];
}

export interface ComposerSlashOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export interface ComposerSlashOptionEmptyState {
  readonly title: string;
  readonly description: string;
}

export interface ComposerModelOption extends ComposerSlashOption {
  readonly providerId: string;
  readonly modelId: string;
}

export interface ComposerProviderOption extends ComposerSlashOption {
  readonly providerId: string;
}

export const MODEL_OPTIONS_EMPTY_TITLE_KEY = "composer.model.emptyTitle" as const;
export const MODEL_OPTIONS_EMPTY_DESCRIPTION_KEY = "composer.model.emptyDescription" as const;

type HostActionSlashCommand = Omit<ComposerSlashCommand, "title" | "description" | "template"> & {
  readonly titleKey: MessageKey;
  readonly descriptionKey: MessageKey;
  readonly template?: string;
  readonly templateKey?: MessageKey;
};

const HOST_ACTION_SLASH_COMMANDS: readonly HostActionSlashCommand[] = [
  {
    id: "host:model",
    kind: "model",
    command: "/model",
    template: "/model",
    titleKey: "composer.cmd.model.title",
    descriptionKey: "composer.cmd.model.description",
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:thinking",
    kind: "thinking",
    command: "/thinking",
    template: "/thinking",
    titleKey: "composer.cmd.thinking.title",
    descriptionKey: "composer.cmd.thinking.description",
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:tree",
    kind: "tree",
    command: "/tree",
    template: "/tree",
    titleKey: "composer.cmd.tree.title",
    descriptionKey: "composer.cmd.tree.description",
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:status",
    kind: "status",
    command: "/status",
    template: "/status",
    titleKey: "composer.cmd.status.title",
    descriptionKey: "composer.cmd.status.description",
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:login",
    kind: "login",
    command: "/login",
    template: "/login",
    titleKey: "composer.cmd.login.title",
    descriptionKey: "composer.cmd.login.description",
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:logout",
    kind: "logout",
    command: "/logout",
    template: "/logout",
    titleKey: "composer.cmd.logout.title",
    descriptionKey: "composer.cmd.logout.description",
    submitMode: "pick-option",
    section: "host",
  },
  {
    id: "host:settings",
    kind: "settings",
    command: "/settings",
    template: "/settings",
    titleKey: "composer.cmd.settings.title",
    descriptionKey: "composer.cmd.settings.description",
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:scoped-models",
    kind: "scoped-models",
    command: "/scoped-models",
    template: "/scoped-models",
    titleKey: "composer.cmd.enabledModels.title",
    descriptionKey: "composer.cmd.enabledModels.description",
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:session",
    kind: "session",
    command: "/session",
    template: "/session",
    titleKey: "composer.cmd.session.title",
    descriptionKey: "composer.cmd.session.description",
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:name",
    kind: "name",
    command: "/name",
    templateKey: "composer.cmd.rename.template",
    titleKey: "composer.cmd.rename.title",
    descriptionKey: "composer.cmd.rename.description",
    submitMode: "prefill",
    section: "host",
  },
  {
    id: "host:compact",
    kind: "compact",
    command: "/compact",
    template: "/compact",
    titleKey: "composer.cmd.compact.title",
    descriptionKey: "composer.cmd.compact.description",
    submitMode: "immediate",
    section: "host",
  },
  {
    id: "host:reload",
    kind: "reload",
    command: "/reload",
    template: "/reload",
    titleKey: "composer.cmd.reload.title",
    descriptionKey: "composer.cmd.reload.description",
    submitMode: "immediate",
    section: "host",
  },
] as const;

/**
 * The built-in slash commands. The table carries catalog keys so titles and
 * descriptions follow the app language.
 */
export function hostActionSlashCommands(t: Translate = translate): readonly ComposerSlashCommand[] {
  return HOST_ACTION_SLASH_COMMANDS.map((command) => ({
    ...command,
    title: t(command.titleKey),
    description: t(command.descriptionKey),
    template: command.templateKey ? t(command.templateKey) : (command.template ?? command.command),
  }));
}

const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The reasoning levels offered by the thinking picker, localised per render. */
export function thinkingOptions(t: Translate = translate): readonly ComposerSlashOption[] {
  return THINKING_LEVELS.map((value) => ({
    value,
    label: t(`composer.thinking.${value}`),
    description: t(`composer.thinking.${value}.description`),
  }));
}

export function buildSlashCommandSections(
  query: string,
  runtime: RuntimeSnapshot | undefined,
  sessionCommands: readonly RuntimeCommandRecord[],
  compatibilityRecords: readonly ExtensionCommandCompatibilityRecord[] = [],
  options: {
    readonly allowTreeCommand?: boolean;
  } = {},
  t: Translate = translate,
): readonly ComposerSlashCommandSection[] {
  const normalizedQuery = query.trim().toLowerCase();
  const availableRuntimeCommands = resolveRuntimeCommands(runtime, sessionCommands);
  const compatibilityByKey = new Map(
    compatibilityRecords.map(
      (record) => [`${record.extensionPath}::${record.commandName}`, record] as const,
    ),
  );
  const runtimeMatches = availableRuntimeCommands
    .map<ComposerSlashCommand>((command) => ({
      id: `runtime:${command.source}:${command.name}`,
      kind: "runtime",
      command: `/${command.name}`,
      template: `/${command.name} `,
      title: formatRuntimeCommandTitle(command),
      description: formatRuntimeCommandDescription(command, t),
      submitMode: "prefill",
      section: "runtime",
      runtimeCommand: command,
      sourceLabel: formatRuntimeSourceLabel(command, t),
      compatibility: compatibilityByKey.get(`${command.sourceInfo.path}::${command.name}`),
    }))
    .filter((command) => matchesCommand(command, normalizedQuery));
  const allowTreeCommand = options.allowTreeCommand ?? true;
  const hostMatches = hostActionSlashCommands(t).filter(
    (command) =>
      (allowTreeCommand || command.kind !== "tree") && matchesCommand(command, normalizedQuery),
  );

  // Prefer a host action when it is a prefix match and runtime skills only
  // match fuzzily. Otherwise an installed skill such as `observe-state` can
  // steal `/stat` from the built-in `/status` command on Tab.
  const hostHasPrefixMatch = hostMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeHasPrefixMatch = runtimeMatches.some((command) =>
    command.command.toLowerCase().startsWith(normalizedQuery),
  );
  const runtimeSection: ComposerSlashCommandSection = {
    id: "runtime",
    title: runtimeMatches.length > 0 ? t("composer.slash.runtimeSection") : undefined,
    items: runtimeMatches,
  };
  const hostSection: ComposerSlashCommandSection = {
    id: "host",
    title: hostMatches.length > 0 ? t("composer.slash.hostSection") : undefined,
    items: hostMatches,
  };
  const sections: ComposerSlashCommandSection[] =
    hostHasPrefixMatch && !runtimeHasPrefixMatch
      ? [hostSection, runtimeSection]
      : [runtimeSection, hostSection];

  return sections.filter((section) => section.items.length > 0);
}

export function flattenSlashSections(
  sections: readonly ComposerSlashCommandSection[],
): readonly ComposerSlashCommand[] {
  return sections.flatMap((section) => section.items);
}

export function buildProviderOptions(
  providers: readonly RuntimeProviderRecord[],
  filter: (provider: RuntimeProviderRecord) => boolean = () => true,
  t: Translate = translate,
): readonly ComposerProviderOption[] {
  return providers
    .filter(filter)
    .sort(compareProviders)
    .map((provider) => ({
      value: provider.id,
      label: provider.name,
      description: describeProvider(provider, t),
      providerId: provider.id,
    }));
}

export function buildModelOptions(
  runtime: RuntimeSnapshot | undefined,
): readonly ComposerModelOption[] {
  if (!runtime) {
    return [];
  }

  return runtime.models
    .filter((model) => model.available && model.scope !== "off")
    .sort((left: RuntimeSnapshot["models"][number], right: RuntimeSnapshot["models"][number]) => {
      const providerCompare =
        providerRankForId(runtime.providers, left.providerId) -
        providerRankForId(runtime.providers, right.providerId);
      if (providerCompare !== 0) {
        return providerCompare;
      }
      return `${left.providerName} ${left.label}`.localeCompare(
        `${right.providerName} ${right.label}`,
      );
    })
    .map((model: RuntimeSnapshot["models"][number]) => ({
      value: model.modelId,
      label: `${model.providerName} · ${model.label}`,
      description: model.modelId,
      providerId: model.providerId,
      modelId: model.modelId,
    }));
}

export function slashOptionsForCommand(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
  t: Translate = translate,
): readonly ComposerSlashOption[] {
  if (!command) {
    return [];
  }

  if (command.kind === "thinking") {
    return thinkingOptions(t);
  }
  if (command.kind === "model") {
    return buildModelOptions(runtime);
  }
  if (command.kind === "login") {
    return buildProviderOptions(runtime?.providers ?? [], (provider) => provider.oauthSupported);
  }
  if (command.kind === "logout") {
    return buildProviderOptions(
      runtime?.providers ?? [],
      (provider) => provider.authSource === "oauth" || provider.authSource === "auth_file",
    );
  }

  return [];
}

export function slashOptionEmptyState(
  command: ComposerSlashCommand | undefined,
  runtime?: RuntimeSnapshot,
  t: Translate = translate,
): ComposerSlashOptionEmptyState | undefined {
  if (!command) {
    return undefined;
  }

  if (command.kind === "model" && buildModelOptions(runtime).length === 0) {
    return {
      title: t(MODEL_OPTIONS_EMPTY_TITLE_KEY),
      description: t(MODEL_OPTIONS_EMPTY_DESCRIPTION_KEY),
    };
  }

  return undefined;
}

function matchesCommand(command: ComposerSlashCommand, normalizedQuery: string): boolean {
  if (!normalizedQuery.startsWith("/")) {
    return false;
  }

  if (normalizedQuery === "/") {
    return true;
  }

  const queryWithoutSlash = normalizedQuery.replace(/^\/+/, "").trim();
  const rawSearchTerms = [command.command.toLowerCase()];
  const aliasSearchTerms = buildSlashSearchAliases(command);
  if (rawSearchTerms.some((value) => value.includes(normalizedQuery))) {
    return true;
  }

  if (!queryWithoutSlash) {
    return false;
  }

  return aliasSearchTerms.some((value) => value.includes(queryWithoutSlash));
}

function buildSlashSearchAliases(command: ComposerSlashCommand): readonly string[] {
  const aliases = new Set<string>([
    command.command.replace(/^\/+/, "").toLowerCase(),
    command.title.toLowerCase(),
    command.sourceLabel?.toLowerCase() ?? "",
    command.compatibility?.status === "terminal-only" ? "terminal-only" : "",
  ]);

  if (command.runtimeCommand) {
    aliases.add(command.runtimeCommand.name.toLowerCase());
    aliases.add(command.runtimeCommand.name.replace(/^skill:/, "").toLowerCase());
  }

  return [...aliases].filter(Boolean);
}

function describeProvider(provider: RuntimeProviderRecord, t: Translate): string {
  if (provider.authSource === "oauth") {
    return t("composer.cmd.provider.oauthConnected");
  }
  if (provider.authSource === "auth_file") {
    return t("composer.cmd.provider.savedKey");
  }
  if (provider.authSource === "env") {
    return t("composer.cmd.provider.env");
  }
  if (provider.authSource === "external") {
    return t("composer.cmd.provider.external");
  }
  if (provider.oauthSupported) {
    return t("composer.cmd.provider.oauthAvailable");
  }
  if (provider.apiKeySetupSupported) {
    return t("composer.cmd.provider.needsKey");
  }
  return t("composer.cmd.provider.available");
}

function compareProviders(left: RuntimeProviderRecord, right: RuntimeProviderRecord): number {
  const leftRank = providerRank(left);
  const rightRank = providerRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.name.localeCompare(right.name);
}

function providerRank(provider: RuntimeProviderRecord): number {
  if (provider.hasAuth) {
    return 0;
  }
  if (provider.id === "openai" || provider.id === "openai-codex" || provider.id === "anthropic") {
    return 1;
  }
  if (provider.oauthSupported) {
    return 2;
  }
  return 3;
}

function providerRankForId(
  providers: readonly RuntimeProviderRecord[],
  providerId: string,
): number {
  const provider = providers.find((entry) => entry.id === providerId);
  return provider ? providerRank(provider) : 99;
}

function summarizeSkillDescription(value: string, t: Translate = translate): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return t("composer.cmd.reusableWorkflow");
  }

  const firstSentence = trimmed.match(/^[^.!?]+[.!?]?/)?.[0]?.trim() ?? trimmed;
  return firstSentence.length > 96 ? `${firstSentence.slice(0, 93).trimEnd()}...` : firstSentence;
}

function formatRuntimeCommandTitle(command: RuntimeCommandRecord): string {
  if (command.source === "skill" && command.name.startsWith("skill:")) {
    return titleCase(command.name.slice("skill:".length));
  }
  return titleCase(command.name.replace(/[:_-]+/g, " "));
}

function formatRuntimeCommandDescription(command: RuntimeCommandRecord, t: Translate): string {
  if (command.description?.trim()) {
    return command.description.trim();
  }
  if (command.source === "prompt") {
    return t("composer.cmd.promptTemplate");
  }
  if (command.source === "skill") {
    return t("composer.cmd.skillCommand");
  }
  return t("composer.cmd.extensionCommand");
}

function formatRuntimeSourceLabel(command: RuntimeCommandRecord, t: Translate): string {
  if (command.source === "skill") {
    return t("composer.cmd.source.skill");
  }
  if (command.source === "prompt") {
    return t("composer.cmd.source.prompt");
  }
  return command.sourceInfo.source.replace(/^extension:/, "");
}

export function isExactSlashCommand(query: string, command: ComposerSlashCommand): boolean {
  return query.trim().toLowerCase() === command.command.toLowerCase();
}

export function parseTreeComposerCommand(
  value: string,
): { readonly type: "tree" } | { readonly type: "error"; readonly message: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const [command, ...rest] = trimmed.split(/\s+/);
  if (command !== "/tree") {
    return undefined;
  }

  if (rest.length > 0) {
    return {
      type: "error",
      message: translate("composer.tree.noArguments"),
    };
  }

  return { type: "tree" };
}
