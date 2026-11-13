import { useTranslation, type Translate } from "../../i18n";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  CUSTOM_MODEL_MAX_TOKENS_FIELDS,
  CUSTOM_MODEL_THINKING_FORMATS,
  CUSTOM_PROVIDER_ID_PATTERN,
  OPENAI_COMPLETIONS_API,
  isCustomProviderApi,
  type CustomProviderApi,
  isValidHttpBaseUrl,
  type CustomModelMaxTokensField,
  type CustomModelThinkingFormat,
} from "@pi-gui/pi-sdk-driver/custom-provider-types";
import {
  Check as CheckIcon,
  LoaderCircle,
  Play,
  Plus as PlusIcon,
  RefreshCw as RefreshIcon,
  Search as SearchIcon,
  SlidersHorizontal as SettingsIcon,
  Trash2,
  X as CloseIcon,
} from "lucide-react";
import { trapDialogFocus } from "../../ui/dialog-focus";
import type { CustomProviderConfig, CustomProviderModelConfig } from "../../../contracts/ipc";
import { SettingsSelect } from "./settings-controls";
import { SettingsGroup } from "./settings-utils";

interface SettingsCustomEndpointsSectionProps {
  readonly existingProviderIds: readonly string[];
  readonly onSaveCustomProvider: (config: CustomProviderConfig) => Promise<string | undefined>;
  readonly onDeleteCustomProvider: (providerId: string) => Promise<string | undefined>;
}

type DialogMode =
  { kind: "closed" } | { kind: "create" } | { kind: "edit"; original: CustomProviderConfig };

export function SettingsCustomEndpointsSection({
  existingProviderIds,
  onSaveCustomProvider,
  onDeleteCustomProvider,
}: SettingsCustomEndpointsSectionProps) {
  const { t } = useTranslation();

  const [entries, setEntries] = useState<readonly CustomProviderConfig[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<DialogMode>({ kind: "closed" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .listCustomProviders()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoadError(undefined);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const handleSave = useCallback(
    async (config: CustomProviderConfig): Promise<string | undefined> => {
      const error = await onSaveCustomProvider(config);
      if (!error) {
        reload();
      }
      return error;
    },
    [onSaveCustomProvider, reload],
  );

  const handleDelete = useCallback(
    async (providerId: string) => {
      const error = await onDeleteCustomProvider(providerId);
      if (error) {
        setLoadError(error);
        return;
      }
      reload();
    },
    [onDeleteCustomProvider, reload],
  );

  return (
    <>
      <SettingsGroup
        title={t("settings.customEndpoints.title")}
        description={t("settings.customEndpoints.description")}
      >
        {loadError ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{loadError}</span>
          </div>
        ) : null}
        {entries.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">{t("settings.customEndpoints.empty")}</span>
          </div>
        ) : (
          entries.map((entry) => (
            <div key={entry.providerId} className="settings-row">
              <div className="settings-row__label">
                <div className="settings-row__title">{entry.providerId}</div>
                <div className="settings-row__description">
                  {entry.baseUrl} · {t("models.count", { count: entry.models.length })}
                </div>
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "edit", original: entry })}
                >
                  {t("settings.common.edit")}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() =>
                    void handleDelete(entry.providerId).catch((error: unknown) => {
                      setLoadError(error instanceof Error ? error.message : String(error));
                    })
                  }
                >
                  {t("settings.common.remove")}
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">{t("settings.customEndpoints.addEndpoint")}</div>
            <div className="settings-row__description">
              {t("settings.customEndpoints.registerHint")}
            </div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "create" })}>
              {t("settings.customEndpoints.addEndpoint")}
            </button>
          </div>
        </div>
      </SettingsGroup>

      {dialog.kind !== "closed" ? (
        <CustomEndpointDialog
          mode={dialog}
          existingProviderIds={existingProviderIds}
          onClose={() => setDialog({ kind: "closed" })}
          onSave={handleSave}
        />
      ) : null}
    </>
  );
}

interface CustomEndpointDialogProps {
  readonly mode: Exclude<DialogMode, { kind: "closed" }>;
  readonly existingProviderIds: readonly string[];
  readonly onClose: () => void;
  readonly onSave: (config: CustomProviderConfig) => Promise<string | undefined>;
}

function CustomEndpointDialog({
  mode,
  existingProviderIds,
  onClose,
  onSave,
}: CustomEndpointDialogProps) {
  const { t } = useTranslation();

  const titleId = useId();
  const initial = mode.kind === "edit" ? mode.original : undefined;
  const [providerId, setProviderId] = useState(initial?.providerId ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [providerApi, setProviderApi] = useState<CustomProviderApi>(
    initial?.api ?? OPENAI_COMPLETIONS_API,
  );
  const [models, setModels] = useState<CustomProviderModelConfig[]>(
    initial ? [...initial.models] : [],
  );
  const [syncOpen, setSyncOpen] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [savePending, setSavePending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const probeButtonRef = useRef<HTMLButtonElement>(null);


  const selectedModelIds = useMemo(() => new Set(models.map((model) => model.id)), [models]);
  const isEdit = mode.kind === "edit";

  const idValidationError = useMemo(
    () => validateProviderId(providerId, existingProviderIds, initial?.providerId, t),
    [providerId, existingProviderIds, initial?.providerId, t],
  );

  const closeSync = () => {
    setSyncOpen(false);
    probeButtonRef.current?.focus();
  };

  const testModel = async (model: CustomProviderModelConfig) => {
    if (!window.piApp) throw new Error(t("providers.bridgeUnavailable"));
    if (!isValidHttpBaseUrl(baseUrl)) throw new Error(t("providers.invalidUrl"));
    return window.piApp.testCustomProviderModel({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      api: providerApi,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      models: [model],
    });
  };

  const updateModel = (id: string, patch: CustomProviderModelPatch) => {
    setModels((current) =>
      current.map((model) => {
        if (model.id !== id) {
          return model;
        }
        const next: MutableModelConfig = { ...model, ...patch };
        // Cleared fields are removed so models.json keeps only what was chosen.
        for (const key of Object.keys(next) as (keyof MutableModelConfig)[]) {
          if (next[key] === undefined) {
            delete next[key];
          }
        }
        return next;
      }),
    );
  };

  const handleManualAdd = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) {
      return;
    }
    if (selectedModelIds.has(trimmed)) {
      return;
    }
    setModels((current) => [...current, { id: trimmed }]);
  };

  const handleSave = async () => {
    if (idValidationError) {
      setFormError(idValidationError);
      return;
    }
    if (!isValidHttpBaseUrl(baseUrl)) {
      setFormError(t("providers.invalidUrl"));
      return;
    }
    if (models.length === 0) {
      setFormError(t("providers.selectModel"));
      return;
    }
    setSavePending(true);
    setFormError(undefined);
    const error = await onSave({
      providerId: providerId.trim(),
      baseUrl: baseUrl.trim(),
      api: providerApi,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      models:
        providerApi === OPENAI_COMPLETIONS_API
          ? models
          : models.map(
              ({ maxTokensField: _maxTokensField, thinkingFormat: _thinkingFormat, ...model }) =>
                model,
            ),
    });
    if (error) {
      setSavePending(false);
      setFormError(error);
      return;
    }
    onClose();
  };

  return (
    <div className="extension-dialog-backdrop">
      <div
        aria-labelledby={titleId}
        aria-modal={syncOpen ? undefined : true}
        inert={syncOpen}
        className="extension-dialog custom-endpoint-dialog"
        data-testid="custom-endpoint-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !savePending) {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Tab") {
            trapDialogFocus(event, dialogRef.current);
          }
        }}
        ref={dialogRef}
        role="dialog"
      >
        <div
          className="custom-endpoint-dialog__content"
          data-testid="custom-endpoint-dialog-content"
        >
          <div className="extension-dialog__title" id={titleId}>
            {isEdit ? t("settings.customEndpoints.editTitle") : t("settings.customEndpoints.addTitle")}
          </div>
          <p className="extension-dialog__body">
            {t("settings.customEndpoints.dialogDescription")}
            <code> ~/.pi/agent/models.json</code>.
          </p>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.providerId")}</span>
            <input
              aria-label={t("settings.customEndpoints.providerId")}
              autoFocus={!isEdit}
              className="settings-search"
              disabled={isEdit || savePending}
              placeholder="ollama-local"
              value={providerId}
              onChange={(event) => setProviderId(event.target.value.trim().toLowerCase())}
            />
            {idValidationError ? (
              <span className="settings-row__description settings-warning">
                {idValidationError}
              </span>
            ) : (
              <span className="settings-row__description">
                {t("settings.customEndpoints.providerIdHint")}
              </span>
            )}
          </label>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.protocol")}</span>
            <select
              aria-label={t("settings.customEndpoints.protocol")}
              className="settings-search"
              disabled={savePending}
              value={providerApi}
              onChange={(event) => {
                if (isCustomProviderApi(event.target.value)) {
                  setProviderApi(event.target.value);

                }
              }}
            >
              <option value="openai-completions">{t("settings.customEndpoints.protocolOpenai")}</option>
              <option value="anthropic-messages">{t("settings.customEndpoints.protocolAnthropic")}</option>
            </select>
          </label>
          <label className="settings-field">
            <span>{t("settings.customEndpoints.baseUrl")}</span>
            <input
              aria-label={t("settings.customEndpoints.baseUrl")}
              className="settings-search"
              disabled={savePending}
              placeholder="http://localhost:11434/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            {providerApi === OPENAI_COMPLETIONS_API ? (
              <span className="settings-row__description">
              {t("settings.customEndpoints.baseUrlSuffixLead")}
              <code>/v1</code>
              {t("settings.customEndpoints.baseUrlSuffixOllama")}
              <code>http://localhost:11434/v1</code>
              {t("settings.customEndpoints.baseUrlSuffixVllm")}
              <code>http://localhost:8000/v1</code>.
              </span>
            ) : (
              <span className="settings-row__description">
                {t("settings.customEndpoints.anthropicHint")}
              </span>
            )}
          </label>
          <label className="settings-field">
            <span>{t("settings.provider.status.apiKey")}</span>
            <input
              aria-label={t("settings.provider.status.apiKey")}
              className="settings-search"
              disabled={savePending}
              placeholder={t("settings.customEndpoints.apiKeyHint")}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="settings-row__description">
              {t("settings.customEndpoints.apiKeyHintLead")}
              <code>--api-key</code>
              {t("settings.customEndpoints.apiKeyHintTail")}
            </span>
          </label>

          <div className="settings-field">
            <div className="settings-field__header">
              <span>{t("settings.nav.models")}</span>
              <button
                className="button button--secondary custom-endpoint-sync-button"
                disabled={savePending}
                ref={probeButtonRef}
                type="button"
                onClick={() => setSyncOpen(true)}
              >
                <RefreshIcon />
                {t("settings.customEndpoints.syncModels")}
              </button>
            </div>

            <ModelChecklist
              probed={[]}
              providerApi={providerApi}
              selected={models}
              onTest={testModel}
              onRemove={(id) => setModels((current) => current.filter((model) => model.id !== id))}
              onManualAdd={handleManualAdd}
              onUpdate={updateModel}
              disabled={savePending}
            />
            <p className="settings-row__description">
              {t("settings.customEndpoints.toolCallingHint")}
            </p>
          </div>
        </div>

        <div className="custom-endpoint-dialog__footer" data-testid="custom-endpoint-dialog-footer">
          {formError ? (
            <p className="extension-dialog__body settings-warning">{formError}</p>
          ) : null}
          <div className="extension-dialog__actions">
            <button
              className="button button--secondary"
              disabled={savePending}
              type="button"
              onClick={onClose}
            >
              {t("settings.common.cancel")}
            </button>
            <button
              className="button"
              disabled={
                savePending || Boolean(idValidationError) || models.length === 0 || !baseUrl.trim()
              }
              type="button"
              onClick={() =>
                void handleSave().catch((error: unknown) => {
                  setSavePending(false);
                  setFormError(error instanceof Error ? error.message : String(error));
                })
              }
            >
              {isEdit ? t("settings.customEndpoints.save") : t("settings.customEndpoints.addEndpoint")}
            </button>
          </div>
        </div>
      </div>
      {syncOpen ? (
        <ModelSyncDialog
          providerId={providerId}
          baseUrl={baseUrl}
          apiKey={apiKey}
          providerApi={providerApi}
          selected={models}
          onChange={setModels}
          onClose={closeSync}
        />
      ) : null}
    </div>
  );
}

function ModelSyncDialog({ providerId, baseUrl, apiKey, providerApi, selected, onChange, onClose }: {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly providerApi: CustomProviderApi;
  readonly selected: readonly CustomProviderModelConfig[];
  readonly onChange: (models: CustomProviderModelConfig[]) => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "added" | "missing">("all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(undefined);
    void (async () => {
      try {
        if (!window.piApp) throw new Error(t("providers.bridgeUnavailable"));
        const result = await window.piApp.probeCustomProviderModels({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, api: providerApi });
        if (cancelled) return;
        if (result.ok) setModels(result.models);
        else setError(result.error);
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, apiKey, providerApi, reload, t]);
  const selectedIds = new Set(selected.map((model) => model.id));
  const availableIds = new Set(models);
  const missing = pending || error ? [] : selected.filter((model) => !availableIds.has(model.id));
  const ids = filter === "missing" ? missing.map((model) => model.id) : models.filter((id) => filter !== "added" || selectedIds.has(id));
  const groups = new Map<string, string[]>();
  for (const id of ids.filter((id) => id.toLowerCase().includes(query.trim().toLowerCase()))) {
    const group = id.includes("/") ? id.slice(0, id.indexOf("/")) : providerId || t("settings.nav.models");
    groups.set(group, [...(groups.get(group) ?? []), id]);
  }
  const add = (ids: readonly string[]) => onChange([...selected, ...ids.filter((id) => !selectedIds.has(id)).map((id) => ({ id }))]);
  return (
    <div className="extension-dialog-backdrop model-sync-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="extension-dialog model-sync-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          if (event.key === "Tab") trapDialogFocus(event, dialogRef.current);
        }}>
        <div className="model-sync-dialog__header">
          <h2 id={titleId}>{providerId || t("settings.nav.models")} · {t("settings.nav.models")} <span className="model-sync-dialog__count">{pending ? "…" : models.length}</span></h2>
          <div className="model-sync-dialog__actions">
            <button className="button button--secondary" disabled={pending || !!error || missing.length === 0} onClick={() => onChange(selected.filter((model) => availableIds.has(model.id)))}>{t("settings.customEndpoints.clearMissing")}</button>
            <button className="button button--secondary" disabled={pending || !!error || models.every((id) => selectedIds.has(id))} onClick={() => add(models)}><PlusIcon />{t("settings.customEndpoints.addAll")}</button>
            <button className="icon-button" aria-label={t("settings.common.cancel")} onClick={onClose}><CloseIcon /></button>
          </div>
        </div>
        <div className="model-sync-dialog__search"><SearchIcon /><input autoFocus className="settings-search" placeholder={t("settings.customEndpoints.searchModels")} aria-label={t("settings.customEndpoints.searchModels")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="model-sync-dialog__filters">
          {(["all", "added", "missing"] as const).map((key) => <button key={key} className="settings-segmented__option" aria-pressed={filter === key} disabled={pending || !!error} onClick={() => setFilter(key)}>{t(key === "all" ? "settings.customEndpoints.allModels" : key === "added" ? "settings.customEndpoints.addedModels" : "settings.customEndpoints.missingModels")} <span>{key === "all" ? models.length : key === "added" ? models.filter((id) => selectedIds.has(id)).length : missing.length}</span></button>)}
        </div>
        <div className="model-sync-dialog__list" aria-busy={pending}>
          {pending ? <p className="settings-row__description" role="status">{t("settings.customEndpoints.syncingModels")}</p> : error ? <div role="alert"><p className="settings-warning">{error}</p><button className="button" onClick={() => setReload((value) => value + 1)}><RefreshIcon />{t("settings.customEndpoints.syncModels")}</button></div> : groups.size === 0 ? <p className="settings-row__description">{t("settings.customEndpoints.noModels")}</p> : [...groups].map(([group, ids]) => (
            <section key={group} className="model-sync-dialog__group">
              <div className="model-sync-dialog__group-header"><button aria-expanded={!collapsed.has(group)} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(group)) next.delete(group); else next.add(group); return next; })}><span aria-hidden="true">{collapsed.has(group) ? "›" : "⌄"}</span>{group}<span className="model-sync-dialog__count">{ids.length}</span></button><button className="icon-button" aria-label={t("settings.customEndpoints.addGroup", { group })} disabled={filter === "missing" || ids.every((id) => selectedIds.has(id))} onClick={() => add(ids)}><PlusIcon /></button></div>
              {!collapsed.has(group) ? ids.map((id) => <div className="model-sync-dialog__model" key={id}><span>{id}</span><button className="icon-button" aria-label={t(selectedIds.has(id) ? "settings.customEndpoints.removeSyncedModel" : "settings.customEndpoints.addSyncedModel", { id })} onClick={() => selectedIds.has(id) ? onChange(selected.filter((model) => model.id !== id)) : add([id])}>{selectedIds.has(id) ? <CheckIcon /> : <PlusIcon />}</button></div>) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

type CustomProviderModelPatch = Partial<Omit<CustomProviderModelConfig, "id">>;
type MutableModelConfig = {
  -readonly [Key in keyof CustomProviderModelConfig]: CustomProviderModelConfig[Key];
};

interface ModelChecklistProps {
  readonly providerApi: CustomProviderApi;
  readonly probed: readonly string[];
  readonly selected: readonly CustomProviderModelConfig[];
  readonly onTest: (model: CustomProviderModelConfig) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>; 
  readonly onRemove: (id: string) => void;
  readonly onManualAdd: (id: string) => void;
  readonly onUpdate: (id: string, patch: CustomProviderModelPatch) => void;
  readonly disabled: boolean;
}

function parsePositiveInt(raw: string): number | undefined {
  const value = Number(raw);
  return raw.trim() !== "" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function ModelChecklist({
  providerApi,
  probed,
  selected,
  onTest,
  onRemove,
  onManualAdd,
  onUpdate,
  disabled,
}: ModelChecklistProps) {
  const { t } = useTranslation();

  const [manualDraft, setManualDraft] = useState("");
  const [expandedIds, setExpandedIds] = useState<readonly string[]>([]);
  const [tests, setTests] = useState<Record<string, { pending?: boolean; ok?: boolean; error?: string }>>({});
  const runTest = async (model: CustomProviderModelConfig) => {
    setTests((current) => ({ ...current, [model.id]: { pending: true } }));
    try {
      const result = await onTest(model);
      setTests((current) => ({ ...current, [model.id]: result.ok ? { ok: true } : { error: result.error } }));
    } catch (error) {
      setTests((current) => ({ ...current, [model.id]: { error: error instanceof Error ? error.message : String(error) } }));
    }
  };
  const configs = useMemo(
    () => new Map(selected.map((model) => [model.id, model] as const)),
    [selected],
  );
  const knownIds = useMemo(
    () => new Set([...probed, ...selected.map((model) => model.id)]),
    [probed, selected],
  );

  // `auto` means "let pi detect it from the endpoint URL", which is what an unset field does.
  const autoLabel = t("settings.customEndpoints.auto");
  const thinkingFormatOptions = [
    { value: "auto", label: autoLabel },
    ...CUSTOM_MODEL_THINKING_FORMATS.map((format) => ({ value: format, label: format })),
  ];
  const maxTokensFieldOptions = [
    { value: "auto", label: autoLabel },
    ...CUSTOM_MODEL_MAX_TOKENS_FIELDS.map((field) => ({ value: field, label: field })),
  ];

  const submitManual = () => {
    onManualAdd(manualDraft);
    setManualDraft("");
  };

  const toggleAdvanced = (id: string) => {
    setExpandedIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  return (
    <div className="settings-disclosure__body">
      {knownIds.size === 0 ? (
        <p className="settings-row__description">
          {t("settings.customEndpoints.modelsHint")}
        </p>
      ) : (
        <ul className="settings-list custom-endpoint-model-list">
          {[...knownIds]
            .sort((a, b) => a.localeCompare(b))
            .map((id) => {
              const config = configs.get(id);
              const expanded = config !== undefined && expandedIds.includes(id);
              const displayName = config?.name?.trim();
              return (
                <li key={id} className="settings-row custom-endpoint-model">
                  <div className="custom-endpoint-model__head">
                    <div className="custom-endpoint-model-list__item">
                      <span className="settings-row__title">{displayName || id}</span>
                      {displayName ? (
                        <span className="settings-row__description">{id}</span>
                      ) : null}
                    </div>
                    {config ? (
                      <div className="custom-endpoint-model__actions">
                        <button
                          aria-label={t("settings.customEndpoints.testModel")}
                          title={t("settings.customEndpoints.testModel")}
                          aria-busy={tests[id]?.pending || undefined}
                          className="icon-button"
                          disabled={disabled || tests[id]?.pending}
                          type="button"
                          onClick={() => void runTest(config)}
                        >
                          {tests[id]?.pending ? <LoaderCircle className="custom-endpoint-model__spinner" aria-hidden="true" /> : <Play aria-hidden="true" />}
                        </button>
                        <button
                          aria-label={t("settings.customEndpoints.advanced")}
                          title={t("settings.customEndpoints.advanced")}
                          aria-expanded={expanded}
                          className="icon-button"
                          data-active={expanded || undefined}
                          disabled={disabled}
                          type="button"
                          onClick={() => toggleAdvanced(id)}
                        >
                          <SettingsIcon />
                        </button>
                        <button
                          aria-label={t("settings.customEndpoints.removeSyncedModel", { id })}
                          title={t("settings.customEndpoints.removeSyncedModel", { id })}
                          className="icon-button"
                          disabled={disabled}
                          type="button"
                          onClick={() => onRemove(id)}
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {tests[id] ? (
                    <div className={`custom-endpoint-model__test-result${tests[id]?.error ? " settings-warning" : ""}`} role="status">
                      {tests[id]?.pending ? t("settings.customEndpoints.testing") : tests[id]?.ok ? <><CheckIcon />{t("settings.customEndpoints.testSuccess")}</> : tests[id]?.error}
                    </div>
                  ) : null}
                  {config && expanded ? (
                    <div className="custom-endpoint-model__advanced">
                      <label className="settings-field">
                        <span>{t("settings.customEndpoints.modelName")}</span>
                        <input
                          aria-label={t("settings.customEndpoints.modelName")}
                          className="settings-search"
                          disabled={disabled}
                          placeholder={id}
                          value={config.name ?? ""}
                          onChange={(event) =>
                            onUpdate(id, { name: event.target.value || undefined })
                          }
                        />
                      </label>
                      <div className="custom-endpoint-model__numbers">
                        <label className="settings-field">
                          <span>{t("settings.customEndpoints.contextWindow")}</span>
                          <input
                            aria-label={t("settings.customEndpoints.contextWindow")}
                            className="settings-search"
                            disabled={disabled}
                            min={1}
                            placeholder="128000"
                            step={1}
                            type="number"
                            value={config.contextWindow ?? ""}
                            onChange={(event) =>
                              onUpdate(id, {
                                contextWindow: parsePositiveInt(event.target.value),
                              })
                            }
                          />
                        </label>
                        <label className="settings-field">
                          <span>{t("settings.customEndpoints.maxTokens")}</span>
                          <input
                            aria-label={t("settings.customEndpoints.maxTokens")}
                            className="settings-search"
                            disabled={disabled}
                            min={1}
                            placeholder="16384"
                            step={1}
                            type="number"
                            value={config.maxTokens ?? ""}
                            onChange={(event) =>
                              onUpdate(id, { maxTokens: parsePositiveInt(event.target.value) })
                            }
                          />
                        </label>
                      </div>
                      <div className="custom-endpoint-model__checks">
                        <label>
                          <input
                            type="checkbox"
                            checked={config.supportsImages ?? false}
                            disabled={disabled}
                            onChange={(event) =>
                              onUpdate(id, { supportsImages: event.target.checked || undefined })
                            }
                          />
                          <span>{t("settings.customEndpoints.supportsImages")}</span>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={config.reasoning ?? false}
                            disabled={disabled}
                            onChange={(event) =>
                              onUpdate(id, { reasoning: event.target.checked || undefined })
                            }
                          />
                          <span>{t("settings.customEndpoints.supportsThinking")}</span>
                        </label>
                      </div>
                      {providerApi === OPENAI_COMPLETIONS_API ? (
                        <>
                          <label className="settings-field">
                        <span>{t("settings.customEndpoints.thinkingFormat")}</span>
                        <SettingsSelect
                          label={t("settings.customEndpoints.thinkingFormat")}
                          options={thinkingFormatOptions}
                          value={config.thinkingFormat ?? "auto"}
                          onChange={(value) =>
                            onUpdate(id, {
                              thinkingFormat:
                                value === "auto" ? undefined : (value as CustomModelThinkingFormat),
                            })
                          }
                        />
                      </label>
                      <label className="settings-field">
                        <span>{t("settings.customEndpoints.maxTokensField")}</span>
                        <SettingsSelect
                          label={t("settings.customEndpoints.maxTokensField")}
                          options={maxTokensFieldOptions}
                          value={config.maxTokensField ?? "auto"}
                          onChange={(value) =>
                            onUpdate(id, {
                              maxTokensField:
                                value === "auto" ? undefined : (value as CustomModelMaxTokensField),
                            })
                          }
                        />
                      </label>
                        </>
                      ) : null}
                      <p className="settings-row__description">
                        {t("settings.customEndpoints.advancedHint")}
                      </p>
                    </div>
                  ) : null}
                </li>
              );
            })}
        </ul>
      )}
      <div className="settings-row custom-endpoint-model-add">
        <input
          aria-label={t("settings.customEndpoints.addModelId")}
          className="settings-search"
          disabled={disabled}
          placeholder={t("settings.customEndpoints.addModelId")}
          value={manualDraft}
          onChange={(event) => setManualDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitManual();
            }
          }}
        />
        <button
          className="button button--secondary"
          disabled={disabled || manualDraft.trim().length === 0}
          type="button"
          onClick={submitManual}
        >
          {t("settings.customEndpoints.add")}
        </button>
      </div>
    </div>
  );
}

function validateProviderId(
  candidate: string,
  existing: readonly string[],
  editing: string | undefined,
  t: Translate,
): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return t("providers.requiredId");
  }
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(trimmed)) {
    return t("providers.idFormat");
  }
  if (trimmed !== editing && existing.includes(trimmed)) {
    return t("providers.idInUse", { trimmed: trimmed });
  }
  return undefined;
}
