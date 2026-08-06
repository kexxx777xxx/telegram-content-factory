import type {
  ActionConfig,
  AiAction,
  ApiKeyDto,
  ChainStepInput,
  DryRunResult,
  KeyLevel,
  ModelInfo,
} from '@tcf/shared';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Button, Card, Field, Input, keyName, Notice, Select, Textarea } from './ui';

const ACTION_LABELS: Record<AiAction, { title: string; hint: string }> = {
  topics: { title: 'Теми', hint: 'Поповнення банку тем' },
  post_text: { title: 'Текст поста', hint: 'Основний текст публікації' },
  svg: { title: 'SVG-схема', hint: 'Ілюстрація, коли режим — SVG' },
  svg_repair: { title: 'Ремонт SVG', hint: 'Виклик, коли санітайзер відхилив схему' },
  image_prompt: { title: 'Промпт для зображення', hint: 'Коли режим — image-модель' },
  image: { title: 'Малювання зображення', hint: 'Модель, що малює за промптом вище' },
};

const KEY_LEVEL_LABELS: Record<KeyLevel, string> = {
  action: 'закріплений саме за цією дією',
  project: 'ключ проєкту',
  default: 'дефолтний ключ із налаштувань',
};

const VARIABLES: Record<AiAction, string[]> = {
  topics: ['persona', 'language', 'count', 'existingTopics'],
  post_text: ['persona', 'language', 'topic', 'hashtags'],
  svg: ['topic', 'style'],
  svg_repair: ['error', 'svgSource'],
  image_prompt: ['postText', 'style'],
  image: ['imagePrompt'],
};

/**
 * One editor for both scopes. With `projectId` it edits a project override and
 * shows where each part currently comes from; without it, the global defaults.
 *
 * Everything is collapsed until opened on purpose — most projects never touch
 * this, and the inheritance badges are what keeps that safe to ignore.
 */
export function GenerationConfig({ projectId }: { projectId?: string }) {
  const [configs, setConfigs] = useState<ActionConfig[] | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [open, setOpen] = useState<AiAction | null>(null);

  useEffect(() => {
    void api.getGenerationConfig(projectId).then(setConfigs);
    api
      .listModels()
      .then(setModels)
      .catch((err: unknown) =>
        setModelsError(err instanceof Error ? err.message : 'Каталог моделей недоступний'),
      );
    void api.listKeys().then(setKeys);
  }, [projectId]);

  if (!configs) {
    return (
      <Card title="Моделі та промпти">
        <div className="flex justify-center py-6 text-slate-400">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Моделі та промпти"
      hint={
        projectId
          ? 'За замовчуванням усе успадковується з глобальних налаштувань. Перевизначайте лише те, що справді відрізняється.'
          : 'Глобальні дефолти. Кожен проєкт може перевизначити будь-яку дію.'
      }
    >
      <div className="space-y-3">
        {modelsError && <Notice>Каталог моделей недоступний: {modelsError}</Notice>}

        {configs.map((config) => (
          <ActionRow
            key={config.action}
            config={config}
            models={models}
            keys={keys}
            projectId={projectId}
            expanded={open === config.action}
            onToggle={() => setOpen(open === config.action ? null : config.action)}
            onSaved={setConfigs}
          />
        ))}
      </div>
    </Card>
  );
}

function ActionRow({
  config,
  models,
  keys,
  projectId,
  expanded,
  onToggle,
  onSaved,
}: {
  config: ActionConfig;
  models: ModelInfo[];
  keys: ApiKeyDto[];
  projectId?: string;
  expanded: boolean;
  onToggle: () => void;
  onSaved: (next: ActionConfig[]) => void;
}) {
  const [steps, setSteps] = useState<ChainStepInput[]>(config.steps);
  const [promptBody, setPromptBody] = useState(config.prompt.body);
  const [apiKeyId, setApiKeyId] = useState<string | null>(config.apiKeyId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [dryModel, setDryModel] = useState('');

  useEffect(() => {
    setSteps(config.steps);
    setPromptBody(config.prompt.body);
    setApiKeyId(config.apiKeyId);
  }, [config]);

  const label = ACTION_LABELS[config.action];
  const dirty =
    promptBody !== config.prompt.body ||
    apiKeyId !== config.apiKeyId ||
    JSON.stringify(steps) !== JSON.stringify(config.steps);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      onSaved(
        await api.saveGenerationConfig(config.action, projectId, { steps, promptBody, apiKeyId }),
      );
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function revert() {
    if (!projectId) return;
    setSaving(true);
    try {
      onSaved(await api.clearGenerationOverride(config.action, projectId, { chain: true, prompt: true }));
    } finally {
      setSaving(false);
    }
  }

  async function runDry() {
    if (!projectId) return;
    setRunning(true);
    setDry(null);
    try {
      setDry(
        await api.dryRun(projectId, {
          action: config.action,
          variables: {},
          ...(dryModel ? { model: dryModel } : {}),
        }),
      );
    } catch (err) {
      setDry({
        ok: false,
        text: null,
        model: null,
        promptScope: null,
        promptVersion: null,
        usage: null,
        attempts: [],
        error: err instanceof Error ? err.message : 'Помилка',
        renderedPrompt: null,
      });
    } finally {
      setRunning(false);
    }
  }

  const overridden =
    projectId && (!config.chainInherited || !config.promptInherited || config.apiKeyId !== null);

  return (
    <div className="rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        {expanded ? (
          <ChevronDown className="size-4 text-slate-400" />
        ) : (
          <ChevronRight className="size-4 text-slate-400" />
        )}
        <span className="font-medium">{label.title}</span>
        <span className="text-xs text-slate-500">{label.hint}</span>
        <span className="ml-auto flex items-center gap-2">
          {projectId &&
            (overridden ? (
              <Badge tone="amber">Перевизначено</Badge>
            ) : (
              <Badge>Успадковано з глобальних</Badge>
            ))}
          <span className="text-xs text-slate-400">
            {config.steps.length} {config.steps.length === 1 ? 'модель' : 'моделі'}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="space-y-5 border-t border-slate-200 px-4 py-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">Ланцюжок моделей</span>
              <span className="text-xs text-slate-500">
                Виконуються по черзі; заблокований крок пропускається миттєво
              </span>
            </div>
            <div className="space-y-2">
              {steps.map((step, index) => (
                <StepRow
                  key={index}
                  step={step}
                  index={index}
                  total={steps.length}
                  models={models}
                  action={config.action}
                  onChange={(next) => setSteps(steps.map((s, i) => (i === index ? next : s)))}
                  onMove={(delta) => {
                    const target = index + delta;
                    if (target < 0 || target >= steps.length) return;
                    const next = [...steps];
                    const [moved] = next.splice(index, 1);
                    if (moved) next.splice(target, 0, moved);
                    setSteps(next);
                  }}
                  onRemove={() => setSteps(steps.filter((_, i) => i !== index))}
                />
              ))}
              <button
                type="button"
                onClick={() =>
                  setSteps([
                    ...steps,
                    {
                      provider: 'gemini',
                      model: modelsForAction(models, config.action)[0]?.id ?? '',
                      params: {},
                      promptId: null,
                    },
                  ])
                }
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                <Plus className="size-4" />
                Додати фолбек
              </button>
            </div>
          </div>

          <Field
            label="Яким ключем платимо"
            hint={
              apiKeyId === null ? (
                <>
                  Зараз спрацює <b>{config.keyLabel ?? 'жоден'}</b> —{' '}
                  {KEY_LEVEL_LABELS[config.keyLevel]}.
                </>
              ) : (
                'Закріплено за цим номером: він не зміниться, навіть якщо дефолтним у налаштуваннях стане інший ключ.'
              )
            }
          >
            <Select
              value={apiKeyId ?? ''}
              onChange={(e) => setApiKeyId(e.target.value || null)}
            >
              <option value="">
                {projectId
                  ? 'Як у проєкті (а якщо там не вибрано — дефолтний)'
                  : 'Дефолтний (який позначено в налаштуваннях)'}
              </option>
              {keys
                .filter((k) => k.enabled)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {keyName(k)}
                  </option>
                ))}
            </Select>
          </Field>

          <Field
            label="Промпт"
            hint={
              <>
                Змінні: {VARIABLES[config.action].map((v) => `{{${v}}}`).join(', ')}. Поточна версія:{' '}
                {config.prompt.scope} v{config.prompt.version}.
              </>
            }
          >
            <Textarea
              rows={10}
              value={promptBody}
              className="font-mono text-xs"
              onChange={(e) => setPromptBody(e.target.value)}
            />
          </Field>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Зберегти
            </Button>
            {saved && !dirty && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600">
                <Check className="size-4" />
                Збережено як нову версію
              </span>
            )}
            {overridden && (
              <Button variant="secondary" onClick={() => void revert()} disabled={saving}>
                <RotateCcw className="size-4" />
                Повернути до глобальних
              </Button>
            )}
          </div>

          {projectId && (
            <div className="rounded-lg bg-slate-50 p-4">
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <Field
                  label="Тестовий запуск"
                  hint="Справжній виклик моделі. Нічого не зберігається — ні пост, ні журнал; результат видно тільки тут."
                >
                  <Select value={dryModel} onChange={(e) => setDryModel(e.target.value)}>
                    <option value="">Увесь ланцюжок</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button variant="secondary" onClick={() => void runDry()} disabled={running}>
                  {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                  Запустити
                </Button>
              </div>

              {dry && <DryRunPanel result={dry} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Only models that can do the job.
 *
 * The `image` action needs a drawing model; showing the text models there is
 * how you end up configuring a chain that cannot possibly work.
 */
function modelsForAction(models: ModelInfo[], action: AiAction): ModelInfo[] {
  return action === 'image' ? models.filter((m) => m.supportsImage) : models;
}

function StepRow({
  step,
  index,
  total,
  models,
  action,
  onChange,
  onMove,
  onRemove,
}: {
  step: ChainStepInput;
  index: number;
  total: number;
  models: ModelInfo[];
  action: AiAction;
  onChange: (next: ChainStepInput) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const usable = modelsForAction(models, action);
  // The configured model may no longer be in the catalog — keep it selectable
  // rather than silently switching the operator to a different model.
  const known = usable.some((m) => m.id === step.model);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <span className="w-6 text-xs text-slate-400">{index + 1}.</span>

      <Select
        value={step.model}
        className="w-auto min-w-64 flex-1"
        onChange={(e) => onChange({ ...step, model: e.target.value })}
      >
        {!known && step.model && (
          <option value={step.model}>{step.model} (немає в каталозі)</option>
        )}
        {usable.map((m) => (
          <option key={m.id} value={m.id}>
            {/* The human name matters: "Nano Banana" is gemini-2.5-flash-image,
                and nobody finds it by id alone. */}
            {m.displayName && m.displayName !== m.id ? `${m.displayName} — ${m.id}` : m.id}
          </option>
        ))}
      </Select>

      <Input
        type="number"
        step="0.1"
        min={0}
        max={2}
        placeholder="t°"
        className="w-20"
        value={step.params.temperature ?? ''}
        onChange={(e) =>
          onChange({
            ...step,
            params: {
              ...step.params,
              ...(e.target.value === '' ? { temperature: undefined } : { temperature: Number(e.target.value) }),
            },
          })
        }
      />

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Вище"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
        >
          <ArrowUp className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Нижче"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
        >
          <ArrowDown className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Прибрати"
          disabled={total === 1}
          onClick={onRemove}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Shows the attempt trail, not just the output. When a chain misbehaves the
 * useful answer is which step answered and why the earlier ones did not.
 */
/**
 * The call, shown the way the journal shows one: what went to the model, and
 * what came back.
 *
 * The attempt trail stays above it, because when a chain is misconfigured the
 * useful answer is *which step answered and why the earlier ones did not* —
 * invisible from the output alone.
 */
function DryRunPanel({ result }: { result: DryRunResult }) {
  return (
    <div className="space-y-3">
      {result.attempts.length > 0 && (
        <div className="space-y-1">
          {result.attempts.map((attempt, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`font-medium ${outcomeColor(attempt.outcome)}`}>
                {outcomeLabel(attempt.outcome)}
              </span>
              <code className="rounded bg-white px-1.5 py-0.5">{attempt.model}</code>
              <span className="text-slate-500">
                {attempt.keyLabel}
                {attempt.durationMs !== undefined && ` · ${attempt.durationMs} мс`}
              </span>
              {attempt.detail && <span className="text-slate-500">— {attempt.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {result.renderedPrompt && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
            <Badge>запит</Badge>
            <span>промпт після підстановки змінних</span>
            {result.promptScope && (
              <span className="ml-auto">
                {result.promptScope} v{result.promptVersion}
              </span>
            )}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700">
            {result.renderedPrompt}
          </pre>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
          <Badge tone={result.ok ? 'green' : 'red'}>відповідь</Badge>
          {result.model && <span className="font-mono">{result.model}</span>}
          {result.usage && (
            <span>
              {result.usage.inputTokens}→{result.usage.outputTokens} токенів
            </span>
          )}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-700">
          {result.ok ? result.text : result.error}
        </pre>
      </div>
    </div>
  );
}

function outcomeLabel(outcome: string): string {
  const map: Record<string, string> = {
    success: '✓ успіх',
    rate_limited: '⏳ ліміт',
    auth_failed: '✕ ключ',
    invalid: '✕ запит',
    error: '✕ помилка',
    skipped: '↷ пропущено',
  };
  return map[outcome] ?? outcome;
}

function outcomeColor(outcome: string): string {
  if (outcome === 'success') return 'text-emerald-600';
  if (outcome === 'skipped' || outcome === 'rate_limited') return 'text-amber-600';
  return 'text-red-600';
}
