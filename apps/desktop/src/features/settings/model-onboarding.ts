import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { translate, type Translate } from "../../i18n";
import { buildModelOptions } from "../conversation/composer-commands";

export type ModelOnboardingSettingsSection = "models" | "providers";

export interface ModelOnboardingNotice {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly actionSection: ModelOnboardingSettingsSection;
}

export interface ModelOnboardingState {
  readonly hasSelectableModels: boolean;
  readonly requiresModelSelection: boolean;
  readonly unselectedModelLabel: string;
  readonly emptyModelTitle: string;
  readonly emptyModelDescription: string;
  readonly notice?: ModelOnboardingNotice;
}

interface ModelSelectionInput {
  readonly provider: string | undefined;
  readonly modelId: string | undefined;
}

export function deriveModelOnboardingState(
  runtime: RuntimeSnapshot | undefined,
  currentSelection: ModelSelectionInput,
  t: Translate = translate,
): ModelOnboardingState {
  const selectableModels = buildModelOptions(runtime);
  const selectableSet = new Set(
    selectableModels.map((model) => `${model.providerId}:${model.modelId}`),
  );
  const hasSelectableModels = selectableModels.length > 0;
  const connectedProviderCount =
    runtime?.providers.filter((provider) => provider.hasAuth).length ?? 0;
  const settingsDefault = {
    provider: runtime?.settings.defaultProvider,
    modelId: runtime?.settings.defaultModelId,
  };
  const hasDefaultModel = Boolean(settingsDefault.provider && settingsDefault.modelId);
  const defaultModelUsable = isUsableSelection(settingsDefault, selectableSet);
  const hasCurrentSelection = Boolean(currentSelection.provider && currentSelection.modelId);
  const currentSelectionUsable = isUsableSelection(currentSelection, selectableSet);

  if (!hasSelectableModels) {
    return {
      hasSelectableModels: false,
      requiresModelSelection: true,
      unselectedModelLabel: t("modelOnboarding.noModels"),
      emptyModelTitle: t("modelOnboarding.noModels"),
      emptyModelDescription:
        connectedProviderCount > 0
          ? t("modelOnboarding.empty.enableModels")
          : t("modelOnboarding.empty.connectProvider"),
      notice:
        connectedProviderCount > 0
          ? {
              title: t("modelOnboarding.noModels"),
              description: t("modelOnboarding.allDisabled"),
              actionLabel: t("modelOnboarding.action.openModels"),
              actionSection: "models",
            }
          : {
              title: t("modelOnboarding.noModels"),
              description: t("modelOnboarding.connectFirst"),
              actionLabel: t("modelOnboarding.action.openProviders"),
              actionSection: "providers",
            },
    };
  }

  if (hasCurrentSelection && !currentSelectionUsable) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: true,
      unselectedModelLabel: t("modelOnboarding.pickModel"),
      emptyModelTitle: t("modelOnboarding.noModels"),
      emptyModelDescription: t("modelOnboarding.pickModelShort"),
      notice: {
        title: t("modelOnboarding.selectedUnavailable"),
        description: hasDefaultModel
          ? t("modelOnboarding.selectedUnavailable.withDefault")
          : t("modelOnboarding.selectedUnavailable.noDefault"),
        actionLabel: t("modelOnboarding.action.openModels"),
        actionSection: "models",
      },
    };
  }

  if (!hasDefaultModel) {
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("modelOnboarding.pickModel"),
      emptyModelTitle: t("modelOnboarding.noDefault"),
      emptyModelDescription: t("modelOnboarding.pickModelShort"),
      notice: currentSelectionUsable
        ? undefined
        : {
            title: t("modelOnboarding.noDefault"),
            description: t("modelOnboarding.noDefault.body"),
            actionLabel: t("modelOnboarding.action.openModels"),
            actionSection: "models",
          },
    };
  }

  if (!defaultModelUsable) {
    const defaultLabel = `${settingsDefault.provider}:${settingsDefault.modelId}`;
    return {
      hasSelectableModels: true,
      requiresModelSelection: !currentSelectionUsable,
      unselectedModelLabel: t("modelOnboarding.pickModel"),
      emptyModelTitle: t("modelOnboarding.defaultUnavailable"),
      emptyModelDescription: t("modelOnboarding.pickModelShort"),
      notice: {
        title: t("modelOnboarding.defaultUnavailable"),
        description: currentSelectionUsable
          ? t("modelOnboarding.defaultUnavailable.body", { model: defaultLabel })
          : t("modelOnboarding.defaultUnavailable.withChoice", { model: defaultLabel }),
        actionLabel: t("modelOnboarding.action.openModels"),
        actionSection: "models",
      },
    };
  }

  return {
    hasSelectableModels: true,
    requiresModelSelection: false,
    unselectedModelLabel: t("modelOnboarding.pickModel"),
    emptyModelTitle: t("modelOnboarding.noModels"),
    emptyModelDescription: t("modelOnboarding.pickModelShort"),
  };
}

function isUsableSelection(
  selection: ModelSelectionInput,
  selectableSet: ReadonlySet<string>,
): boolean {
  return Boolean(
    selection.provider &&
    selection.modelId &&
    selectableSet.has(`${selection.provider}:${selection.modelId}`),
  );
}
