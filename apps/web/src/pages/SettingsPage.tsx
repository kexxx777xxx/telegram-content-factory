import type { ApiKeyDto, AppSettingsDto } from '@tcf/shared';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatLocalTime } from '../lib/time';
import { api } from '../api/client';
import { GenerationConfig } from '../components/GenerationConfig';
import { QueueCard } from '../components/QueueCard';
import { Badge, Button, Card, Field, Input, Notice, Select, Textarea, Tabs } from '../components/ui';

type SettingsTab = 'keys' | 'queue' | 'prompts';

const TABS: { value: SettingsTab; label: string }[] = [
  { value: 'keys', label: 'API-ключі' },
  { value: 'prompts', label: 'Моделі і промпти' },
  { value: 'queue', label: 'Черга' },
];

/**
 * Split into tabs like a project, and for the same reason: keys, the global
 * prompt defaults and the queue answer three unrelated questions, and stacking
 * them on one canvas meant scrolling past two of them to reach the third.
 *
 * The tab lives in the URL, so a reload keeps it and «назад» from the key
 * editor comes back here rather than to whatever page was open before.
 */
export function SettingsPage() {
  const { tab } = useParams<{ tab: string }>();
  const navigate = useNavigate();
  const active: SettingsTab = TABS.some((t) => t.value === tab) ? (tab as SettingsTab) : 'keys';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Налаштування</h1>
        <p className="mt-1 text-sm text-slate-500">
          Спільне для всіх проєктів: ключі, дефолти генерації, черга.
        </p>
      </div>

      <Tabs
        value={active}
        options={TABS}
        onChange={(next) => navigate(`/settings/${next}`)}
      />

      {active === 'keys' && <ApiKeysCard />}
      {active === 'prompts' && (
        <>
          <DefaultStyleCard />
          <GenerationConfig />
        </>
      )}
      {active === 'queue' && <QueueCard />}
    </div>
  );
}

/**
 * The style an empty project field falls back to.
 *
 * It used to be a constant compiled into the server: illustrations came out in
 * a look nobody had chosen in the UI, and the only way to find out where it
 * came from was to read the source. Clearing the field restores the built-in
 * one, which is shown right there instead of being implied.
 */
function DefaultStyleCard() {
  const [settings, setSettings] = useState<AppSettingsDto | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api.getSettings().then((loaded) => {
      setSettings(loaded);
      setDraft(loaded.defaultStyle);
    });
  }, []);

  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      const next = await api.saveSettings({ defaultStyle: draft });
      setSettings(next);
      setDraft(next.defaultStyle);
      setSaved(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Стиль ілюстрацій за замовчуванням"
      hint="Підставляється як {{style}} у промпти SVG та зображень для кожного проєкту, який не задав власний стиль. Порожнє поле повертає вбудований стиль системи."
    >
      {!settings ? (
        <div className="flex justify-center py-6 text-slate-400">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          <Textarea
            rows={2}
            value={draft}
            placeholder={settings.builtinStyle}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p className="text-xs text-slate-500">
            {draft.trim()
              ? 'Проєкти без власного стилю малюватимуть у цьому.'
              : `Зараз діє вбудований стиль: ${settings.builtinStyle}`}
          </p>
          <div className="flex items-center gap-3">
            <Button onClick={() => void save()} disabled={busy || draft === settings.defaultStyle}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Зберегти
            </Button>
            {saved && draft === settings.defaultStyle && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600">
                <Check className="size-4" />
                Збережено
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeyDto[] | null>(null);

  const reload = () => api.listKeys().then(setKeys);

  useEffect(() => {
    void reload();
  }, []);

  return (
    <Card
      title="API-ключі"
      hint="Ліміти й блокування після 429 рахуються окремо на кожен ключ. Один ключ — дефолтний: ним оплачується все, для чого не вибрано інший у проєкті чи в дії. Batch вмикається окремо і лише на платному ключі."
      actions={
        <Link
          to="/settings/keys/new"
          className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <Plus className="size-4" />
          Додати ключ
        </Link>
      }
    >
      {!keys ? (
        <div className="flex justify-center py-6 text-slate-400">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <Notice>
          Жодного ключа не додано — генерація не працюватиме. Додайте принаймні один ключ і
          позначте його дефолтним.
        </Notice>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <KeyRow key={key.id} apiKey={key} onChange={() => void reload()} />
          ))}
        </div>
      )}
    </Card>
  );
}

function KeyRow({ apiKey, onChange }: { apiKey: ApiKeyDto; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; modelCount: number; problems: string[] } | null>(
    null,
  );

  async function verify() {
    setBusy(true);
    try {
      setCheck(await api.verifyKey(apiKey.id));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    setBusy(true);
    try {
      await api.updateKey(apiKey.id, { isDefault: true });
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Видалити ключ «${apiKey.label}»?`)) return;
    setBusy(true);
    try {
      await api.deleteKey(apiKey.id);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound className="size-4 text-slate-400" />
        <span className="font-medium">{apiKey.label}</span>
        <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{apiKey.secretMask}</code>
        <Badge tone={apiKey.tier === 'paid' ? 'amber' : 'neutral'}>
          <span
            title={
              apiKey.tier === 'paid'
                ? 'Платний план: доступний batch-тариф.'
                : 'Безкоштовний план: batch недоступний — провайдер відхилить замовлення.'
            }
          >
            {apiKey.tier === 'paid' ? 'paid' : 'free'}
          </span>
        </Badge>
        {apiKey.isDefault && <Badge tone="green">дефолтний</Badge>}
        {apiKey.batchEnabled && (
          <Badge tone="amber">
            <span title="Теми й текст поста наперед ідуть у batch: −50% ціни, відповідь до 24 год. Зображення завжди синхронні — вони в кінці ланцюжка залежностей.">batch</span>
          </Badge>
        )}
        {!apiKey.enabled && <Badge tone="red">вимкнено</Badge>}

        {/*
          Icons without labels: four labelled buttons crowded the row and made
          the key's own name the least prominent thing on it. Each keeps its
          `title`, so the meaning is one hover away.
        */}
        <span className="ml-auto flex items-center gap-1">
          <Link
            to={`/settings/keys/${apiKey.id}`}
            title="Редагувати"
            aria-label="Редагувати"
            className="rounded p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
          >
            <Pencil className="size-4" />
          </Link>
          {!apiKey.isDefault && (
            <IconButton label="Зробити дефолтним" onClick={() => void makeDefault()} disabled={busy}>
              <Star className="size-4" />
            </IconButton>
          )}
          <IconButton label="Перевірити ключ" onClick={() => void verify()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </IconButton>
          <IconButton label="Видалити" tone="danger" onClick={() => void remove()} disabled={busy}>
            <Trash2 className="size-4" />
          </IconButton>
        </span>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          сьогодні: {apiKey.usageToday.requests} запитів
          {apiKey.dailyRequestBudget ? ` / ${apiKey.dailyRequestBudget}` : ''}
        </span>
        <span>
          {apiKey.usageToday.inputTokens}→{apiKey.usageToday.outputTokens} токенів
        </span>
        {apiKey.rpmLimit && <span>ліміт {apiKey.rpmLimit}/хв</span>}
      </div>

      {apiKey.blockedModels.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <AlertTriangle className="size-3.5 text-amber-600" />
          <span className="text-amber-700">
            заблоковано після 429:{' '}
            {apiKey.blockedModels
              .map((b) => `${b.model} до ${formatLocalTime(b.blockedUntil)}`)
              .join(', ')}
          </span>
        </div>
      )}

      {check && (
        <div className="mt-2 text-xs">
          {check.ok ? (
            <span className="flex items-center gap-1.5 text-emerald-600">
              <Check className="size-3.5" />
              Ключ робочий, доступно {check.modelCount} моделей
            </span>
          ) : (
            <span className="flex items-start gap-1.5 text-red-600">
              <X className="mt-0.5 size-3.5 shrink-0" />
              {check.problems.join('; ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Small square action; the label lives in `title`, not on screen. */
function IconButton({
  label,
  onClick,
  disabled,
  tone,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={`rounded p-1.5 transition disabled:opacity-40 ${
        tone === 'danger'
          ? 'text-slate-400 hover:bg-red-50 hover:text-red-600'
          : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Adding and editing a key are one screen with an address of its own.
 *
 * As an inline form it had no way back: the browser's «назад» left the settings
 * page entirely, because opening the form had never been a navigation. Now the
 * arrow and the browser agree — both return to the key list.
 */
export function KeyEditorPage() {
  const { keyId } = useParams<{ keyId: string }>();
  const navigate = useNavigate();
  const [keys, setKeys] = useState<ApiKeyDto[] | null>(null);

  useEffect(() => {
    void api.listKeys().then(setKeys);
  }, []);

  const editing = keyId !== undefined;
  const initial = keys?.find((k) => k.id === keyId);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/settings/keys"
          className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-xl font-semibold">
          {editing ? `Ключ${initial ? ` «${initial.label}»` : ''}` : 'Новий ключ'}
        </h1>
      </div>

      {!keys ? (
        <div className="flex justify-center py-10 text-slate-400">
          <Loader2 className="size-6 animate-spin" />
        </div>
      ) : editing && !initial ? (
        <Notice tone="red">Ключ не знайдено — можливо, його вже видалили.</Notice>
      ) : (
        <Card>
          <KeyForm
            initial={initial}
            hasKeys={keys.length > 0}
            onDone={() => navigate('/settings/keys')}
            onCancel={() => navigate('/settings/keys')}
          />
        </Card>
      )}
    </div>
  );
}

/**
 * One form for adding and for editing.
 *
 * They ask for the same things, and limits are the field most likely to need a
 * second pass — a budget guessed on day one is wrong by day three. Two separate
 * forms would have drifted apart on exactly that field.
 */
function KeyForm({
  initial,
  hasKeys,
  onDone,
  onCancel,
}: {
  initial?: ApiKeyDto;
  hasKeys: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = initial !== undefined;
  const [label, setLabel] = useState(initial?.label ?? '');
  // Never prefilled: the server sends only a mask, and empty means "keep it".
  const [secret, setSecret] = useState('');
  // The first key has to be the default, otherwise nothing can generate.
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? !hasKeys);
  const [tier, setTier] = useState<'free' | 'paid'>(initial?.tier ?? 'free');
  const [batchEnabled, setBatchEnabled] = useState(initial?.batchEnabled ?? false);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [rpmLimit, setRpmLimit] = useState(initial?.rpmLimit?.toString() ?? '');
  const [dailyBudget, setDailyBudget] = useState(initial?.dailyRequestBudget?.toString() ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Batch is a paid-plan feature; the server enforces this too, but a switch
  // that can be flipped into a state the vendor rejects is a trap.
  const batchAvailable = tier === 'paid';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const limits = {
        rpmLimit: rpmLimit ? Number(rpmLimit) : null,
        dailyRequestBudget: dailyBudget ? Number(dailyBudget) : null,
      };
      if (editing) {
        await api.updateKey(initial.id, {
          label,
          isDefault,
          enabled,
          tier,
          batchEnabled: batchAvailable && batchEnabled,
          ...limits,
          ...(secret ? { secret } : {}),
        });
      } else {
        await api.createKey({
          provider: 'gemini',
          label,
          secret,
          isDefault,
          enabled,
          tier,
          batchEnabled: batchAvailable && batchEnabled,
          ...limits,
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося зберегти ключ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Назва">
          <Input value={label} placeholder="Global Gemini" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field
          label="Ключ"
          hint={editing ? 'Порожньо — лишити збережений ключ.' : 'Ключ Gemini API з Google AI Studio.'}
        >
          <Input
            type="password"
            autoComplete="off"
            placeholder={editing ? initial.secretMask : ''}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>

        <Field label="План" hint="Batch працює лише на платному плані: −50% ціни, відповідь до 24 год.">
          <Select
            value={tier}
            onChange={(e) => {
              const next = e.target.value as 'free' | 'paid';
              setTier(next);
              if (next === 'free') setBatchEnabled(false);
            }}
          >
            <option value="free">free — безкоштовний</option>
            <option value="paid">paid — платний</option>
          </Select>
          <label
            className={`flex items-center gap-2 py-2 text-sm ${batchAvailable ? '' : 'text-slate-400'}`}
            title={batchAvailable ? undefined : 'Доступно лише на платному плані'}
          >
            <input
              type="checkbox"
              checked={batchAvailable && batchEnabled}
              disabled={!batchAvailable}
              onChange={(e) => setBatchEnabled(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            Дозволити batch
          </label>
        </Field>

        <Field label="Роль" hint="Дефолтним може бути лише один ключ; попередній стане звичайним.">
          <label className="flex items-center gap-2 py-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              disabled={!hasKeys || (editing && initial.isDefault)}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            Дефолтний ключ
          </label>
          <label className="flex items-center gap-2 py-1 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            Увімкнений
          </label>
        </Field>

        <Field label="Ліміт запитів/хв" hint="Порожньо — реагувати лише на 429.">
          <Input type="number" min={1} value={rpmLimit} onChange={(e) => setRpmLimit(e.target.value)} />
        </Field>
        <Field label="Денний бюджет запитів" hint="Особливо важливий для дефолтного ключа.">
          <Input
            type="number"
            min={1}
            value={dailyBudget}
            onChange={(e) => setDailyBudget(e.target.value)}
          />
        </Field>
      </div>

      {error && <Notice tone="red">{error}</Notice>}

      <div className="flex gap-2">
        <Button onClick={() => void submit()} disabled={busy || !label || (!editing && !secret)}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {editing ? 'Зберегти' : 'Додати'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Скасувати
        </Button>
      </div>
    </div>
  );
}
