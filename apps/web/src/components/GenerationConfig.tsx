import type {
  ActionConfig,
  AiAction,
  ApiKeyDto,
  ChainStepInput,
  DryRunResult,
  KeyLevel,
  ModelInfo,
} from '@tcf/shared';
import { promptVariables } from '@tcf/shared';
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
import { Fragment, useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  InfoHint,
  Input,
  keyName,
  Notice,
  Select,
  Spoiler,
  Textarea,
  VarTag,
} from './ui';

/**
 * The pipeline as an operator thinks of it, not as the code enumerates it.
 *
 * `svg` and `svg_repair` are one job — draw the schematic, and fix it when the
 * sanitiser refuses — and so are `image_prompt` and `image`: describe the
 * picture, then draw the description. Listed as four separate rows they invited
 * the reader to configure each half independently, which is never what anyone
 * wants and is how a chain ends up half-migrated to a different model.
 */
interface ActionGroup {
  key: string;
  title: string;
  hint: string;
  /** First one is the group's main action; the rest are its follow-ups. */
  actions: { action: AiAction; label: string; note?: string }[];
}

const GROUPS: ActionGroup[] = [
  {
    key: 'topics',
    title: 'Теми',
    hint: 'Поповнення банку тем',
    actions: [{ action: 'topics', label: 'Генерація тем' }],
  },
  {
    key: 'post_text',
    title: 'Текст поста',
    hint: 'Основний текст публікації',
    actions: [{ action: 'post_text', label: 'Текст поста' }],
  },
  {
    key: 'svg',
    title: 'SVG-схема',
    hint: 'Ілюстрація, коли режим — SVG',
    actions: [
      { action: 'svg', label: 'Малювання схеми' },
      {
        action: 'svg_repair',
        label: 'Ремонт схеми',
        note: 'Викликається лише тоді, коли санітайзер відхилив результат вище: моделі повертається її ж SVG разом із причиною відмови.',
      },
    ],
  },
  {
    key: 'image',
    title: 'Зображення',
    hint: 'Ілюстрація, коли режим — image-модель',
    actions: [
      { action: 'image_prompt', label: 'Промпт для зображення' },
      {
        action: 'image',
        label: 'Малювання зображення',
        note: 'Малює за промптом, складеним вище. Власного промпта не має — у модель іде рівно той текст, тож тут налаштовуються лише модель і ключ.',
      },
    ],
  },
];

const KEY_LEVEL_LABELS: Record<KeyLevel, string> = {
  action: 'закріплений саме за цією дією',
  project: 'ключ проєкту',
  default: 'дефолтний ключ із налаштувань',
};

/** The drawing model gets the text produced by `image_prompt`, not a template. */
const PROMPTLESS: AiAction[] = ['image'];

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
  const [open, setOpen] = useState<string | null>(null);
  /** Глобальні промпти — те, що стоїть плейсхолдером у порожньому полі проєкту. */
  const [basePrompts, setBasePrompts] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getGenerationConfig(projectId).then(setConfigs);
    if (projectId) {
      void api
        .getGenerationConfig()
        .then((globals) =>
          setBasePrompts(Object.fromEntries(globals.map((c) => [c.action, c.prompt.body]))),
        );
    }
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

        {GROUPS.map((group) => {
          const groupConfigs = group.actions
            .map((a) => configs.find((c) => c.action === a.action))
            .filter((c): c is ActionConfig => c !== undefined);
          if (groupConfigs.length === 0) return null;

          return (
            <GroupRow
              key={group.key}
              group={group}
              configs={groupConfigs}
              models={models}
              keys={keys}
              basePrompts={basePrompts}
              projectId={projectId}
              expanded={open === group.key}
              onToggle={() => setOpen(open === group.key ? null : group.key)}
              onSaved={setConfigs}
            />
          );
        })}
      </div>
    </Card>
  );
}

function GroupRow({
  group,
  configs,
  models,
  keys,
  basePrompts,
  projectId,
  expanded,
  onToggle,
  onSaved,
}: {
  group: ActionGroup;
  configs: ActionConfig[];
  models: ModelInfo[];
  keys: ApiKeyDto[];
  basePrompts: Record<string, string>;
  projectId?: string;
  expanded: boolean;
  onToggle: () => void;
  onSaved: (next: ActionConfig[]) => void;
}) {
  const main = configs[0]!;
  const overridden =
    projectId !== undefined &&
    configs.some((c) => !c.chainInherited || !c.promptInherited || c.apiKeyId !== null);

  return (
    <div className="rounded-lg border border-slate-200">
      {/*
        The collapsed row answers the two questions asked from across the screen:
        which model does this, and who pays. The rest of the chain is a fallback
        list — it matters when something breaks, not while reading.
      */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-slate-400" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-slate-400" />
        )}
        <span className="font-medium">{group.title}</span>
        <span className="text-xs text-slate-500">{group.hint}</span>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {projectId &&
            (overridden ? (
              <Badge tone="amber">Перевизначено</Badge>
            ) : (
              <Badge>Успадковано з глобальних</Badge>
            ))}
          <span className="font-mono text-xs text-slate-500">
            {main.steps[0]?.model ?? 'модель не вибрано'}
          </span>
          {main.steps.length > 1 && (
            <span className="text-xs text-slate-400">+{main.steps.length - 1} резервних</span>
          )}
          <KeyChip keyId={main.keyId} label={main.keyLabel} keys={keys} />
        </span>
      </button>

      {expanded && (
        <div className="space-y-6 border-t border-slate-200 px-4 py-4">
          {configs.map((config, index) => {
            const meta = group.actions[index]!;
            return (
              <ActionEditor
                key={config.action}
                config={config}
                label={configs.length > 1 ? meta.label : null}
                note={meta.note}
                models={models}
                keys={keys}
                basePrompt={basePrompts[config.action] ?? ''}
                projectId={projectId}
                onSaved={onSaved}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The key by name, with what its plan allows.
 *
 * «Дефолтний ключ» told an operator which *rule* picked the key, never which
 * key that was — so whether this action can batch, the thing the rule exists to
 * decide, stayed invisible.
 */
function KeyChip({
  keyId,
  label,
  keys,
}: {
  keyId: string | null;
  label: string | null;
  keys: ApiKeyDto[];
}) {
  const key = keys.find((k) => k.id === keyId);
  if (!key) return <span className="text-xs text-slate-400">{label ?? 'ключа немає'}</span>;

  // Один значок замість двох: batch буває лише на платному тарифі, тож
  // «paid» поруч із «batch» повторював те саме іншими літерами.
  return (
    <span className="flex items-center gap-1 text-xs text-slate-600">
      {key.label}
      <Badge tone={key.tier === 'paid' ? 'amber' : 'neutral'}>
        {key.batchEnabled ? 'batch' : key.tier}
      </Badge>
      {!key.enabled && <Badge tone="red">вимкнено</Badge>}
    </span>
  );
}

function ActionEditor({
  config,
  label,
  note,
  models,
  keys,
  basePrompt,
  projectId,
  onSaved,
}: {
  config: ActionConfig;
  /** Set only inside a group with more than one action. */
  label: string | null;
  note?: string;
  models: ModelInfo[];
  keys: ApiKeyDto[];
  /** Глобальний промпт цієї дії; у проєкті стоїть плейсхолдером. Порожній у глобальному режимі. */
  basePrompt: string;
  projectId?: string;
  onSaved: (next: ActionConfig[]) => void;
}) {
  /*
   * У проєкті поле порожнє, поки промпт успадкований, а базовий текст видно
   * плейсхолдером. Підставляти глобальний текст у саме поле означало, що
   * «зберегти» після будь-якої дрібної правки поруч робило копію глобального
   * промпта — і та копія переставала оновлюватись разом з оригіналом.
   */
  const ownPrompt = config.promptInherited ? '' : config.prompt.body;
  const [steps, setSteps] = useState<ChainStepInput[]>(config.steps);
  const [promptBody, setPromptBody] = useState(ownPrompt);
  const [apiKeyId, setApiKeyId] = useState<string | null>(config.apiKeyId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dry, setDry] = useState<DryRunResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setSteps(config.steps);
    setPromptBody(config.promptInherited ? '' : config.prompt.body);
    setApiKeyId(config.apiKeyId);
  }, [config]);

  const hasPrompt = !PROMPTLESS.includes(config.action);
  const dirty =
    (hasPrompt && promptBody !== ownPrompt) ||
    apiKeyId !== config.apiKeyId ||
    JSON.stringify(steps) !== JSON.stringify(config.steps);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      onSaved(
        await api.saveGenerationConfig(config.action, projectId, {
          steps,
          apiKeyId,
          ...(hasPrompt ? { promptBody } : {}),
        }),
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
      // Тільки ланцюжок і ключ: промпт повертається очищенням свого поля, і
      // забрати заразом чужу правку тексту було б несподіванкою.
      onSaved(
        await api.clearGenerationOverride(config.action, projectId, { chain: true, prompt: false }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function runDry() {
    if (!projectId) return;
    setRunning(true);
    setDry(null);
    try {
      setDry(await api.dryRun(projectId, { action: config.action, variables: {} }));
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

  const overridden = projectId && (!config.chainInherited || config.apiKeyId !== null);

  return (
    <div className="space-y-4">
      {label && (
        <div className="flex items-center gap-1.5 border-b border-slate-100 pb-2">
          <span className="text-sm font-semibold text-slate-800">{label}</span>
          {note && <InfoHint>{note}</InfoHint>}
        </div>
      )}

      <ChainEditor
        steps={steps}
        models={models}
        action={config.action}
        onChange={setSteps}
      />

      {/*
        Один рядок, а не два: назва ключа, його тариф і те, звідки він узявся —
        одна відповідь на одне питання. Три місця з тим самим «paid» поруч
        читались як три різні факти.
      */}
      <Field
        label="Ключ"
        hint={
          apiKeyId === null
            ? `Обирається автоматично: ${KEY_LEVEL_LABELS[config.keyLevel]}. Зміниться разом із налаштуваннями.`
            : 'Закріплено: не зміниться, навіть якщо дефолтним у налаштуваннях стане інший.'
        }
      >
        <Select value={apiKeyId ?? ''} onChange={(e) => setApiKeyId(e.target.value || null)}>
          <option value="">
            {config.keyLabel
              ? `Авто — ${config.keyLabel} (${KEY_LEVEL_LABELS[config.keyLevel]})`
              : 'Авто — жодного ключа не знайдено'}
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

      {hasPrompt ? (
        <div className="space-y-2">
          <Field
            label="Промпт"
            hint={
              projectId ? (
                <>
                  Порожнє поле — працює глобальний промпт (він і стоїть підказкою). Пишіть сюди
                  лише те, що для цього проєкту має бути інакше; щоб повернутись до глобального,
                  очистіть поле і збережіть. Поточний: {config.prompt.scope} v
                  {config.prompt.version}.
                </>
              ) : (
                <>
                  Зберігається новою версією, стара лишається: опублікований пост посилається на ту
                  версію, що його породила. Поточна: {config.prompt.scope} v{config.prompt.version}.
                </>
              )
            }
          >
            <Textarea
              rows={10}
              value={promptBody}
              placeholder={basePrompt}
              className="font-mono text-xs"
              onChange={(e) => setPromptBody(e.target.value)}
            />
          </Field>
          <VariableReference action={config.action} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">{note}</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={saving || !dirty}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          Зберегти
        </Button>
        {saved && !dirty && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600">
            <Check className="size-4" />
            Збережено{hasPrompt ? ' як нову версію' : ''}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {overridden && (
            <Button variant="secondary" onClick={() => void revert()} disabled={saving}>
              <RotateCcw className="size-4" />
              Моделі й ключ — як у глобальних
            </Button>
          )}
          {projectId && (
            <>
              <Button variant="secondary" onClick={() => void runDry()} disabled={running}>
                {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                Тестовий запуск
              </Button>
              <InfoHint>
                Справжній виклик за налаштуваннями вище: промпт іде в першу модель, а якщо та
                зайнята чи впала — у наступну. Нічого не зберігається й нікуди не публікується, але
                виклик платний.
              </InfoHint>
            </>
          )}
        </span>
      </div>

      {dry && (
        <div className="rounded-lg bg-slate-50 p-4">
          <DryRunPanel result={dry} />
        </div>
      )}
    </div>
  );
}

/**
 * The first model, always visible; the fallbacks folded away.
 *
 * A chain is read top-down exactly once — when something is wrong. The rest of
 * the time only the first line is true in practice, and five dropdowns stacked
 * on top of each other made every action look equally complicated.
 */
function ChainEditor({
  steps,
  models,
  action,
  onChange,
}: {
  steps: ChainStepInput[];
  models: ModelInfo[];
  action: AiAction;
  onChange: (next: ChainStepInput[]) => void;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    if (moved) next.splice(target, 0, moved);
    onChange(next);
  };

  const rowProps = (index: number) => ({
    step: steps[index]!,
    index,
    total: steps.length,
    models,
    action,
    onChange: (next: ChainStepInput) => onChange(steps.map((s, i) => (i === index ? next : s))),
    onMove: (delta: number) => move(index, delta),
    onRemove: () => onChange(steps.filter((_, i) => i !== index)),
  });

  const addStep = () =>
    onChange([
      ...steps,
      {
        provider: 'gemini',
        model: modelsForAction(models, action)[0]?.id ?? '',
        params: {},
        promptId: null,
      },
    ]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium text-slate-700">Основна модель</span>
        <InfoHint>
          Моделі пробуються згори вниз. Крок, заблокований після 429 або недоступний,
          пропускається миттєво — наступний отримує той самий промпт.
        </InfoHint>
      </div>

      {steps.length > 0 && <StepRow {...rowProps(0)} />}

      <Spoiler
        label={
          steps.length > 1 ? `Резервні моделі: ${steps.length - 1}` : 'Резервних моделей немає'
        }
      >
        <div className="space-y-2">
          {steps.slice(1).map((_, i) => (
            <StepRow key={i + 1} {...rowProps(i + 1)} />
          ))}
          <button
            type="button"
            onClick={addStep}
            className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-white"
          >
            <Plus className="size-4" />
            Додати фолбек
          </button>
        </div>
      </Spoiler>
    </div>
  );
}

/**
 * The reference an operator needs while editing a prompt: every placeholder the
 * action understands, what lands in it, and which setting supplies it.
 *
 * It lists what *may* be used, not what the current text happens to mention —
 * the point is to discover `{{persona}}` in an illustration prompt, and a list
 * derived from the prompt itself could never show that.
 */
function VariableReference({ action }: { action: AiAction }) {
  const variables = promptVariables(action);

  return (
    <Spoiler label={`Довідник змінних: ${variables.length} доступних тут`}>
      <p className="mb-2 text-xs text-slate-500">
        Будь-яку з них можна вставити в промпт вище. Невідома назва в подвійних дужках
        підставляється порожнім рядком, а не лишається в тексті.
      </p>
      <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-[9rem_1fr]">
        {variables.map((variable) => (
          <Fragment key={variable.name}>
            <dt>
              <VarTag name={variable.name} />
            </dt>
            <dd className="text-slate-600">
              {variable.meaning}
              <span className="block text-slate-400">{variable.source}</span>
            </dd>
          </Fragment>
        ))}
      </dl>
    </Spoiler>
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
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <span className="w-6 shrink-0 text-xs text-slate-400">{index + 1}.</span>

      <Select
        value={step.model}
        className="w-auto min-w-0 flex-1"
        onChange={(e) => onChange({ ...step, model: e.target.value })}
      >
        {!known && step.model && <option value={step.model}>{step.model} (немає в каталозі)</option>}
        {usable.map((m) => (
          <option key={m.id} value={m.id}>
            {/* The human name matters: "Nano Banana" is gemini-2.5-flash-image,
                and nobody finds it by id alone. */}
            {m.displayName && m.displayName !== m.id ? `${m.displayName} — ${m.id}` : m.id}
          </option>
        ))}
      </Select>

      <div className="flex shrink-0 items-center gap-0.5">
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
