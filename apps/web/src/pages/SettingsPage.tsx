import type { ApiKeyDto } from '@tcf/shared';
import { AlertTriangle, Check, KeyRound, Layers, Loader2, Plus, RefreshCw, Star, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { GenerationConfig } from '../components/GenerationConfig';
import { QueueCard } from '../components/QueueCard';
import { Badge, Button, Card, Field, Input, Notice, Select } from '../components/ui';

export function SettingsPage() {
  const [keys, setKeys] = useState<ApiKeyDto[] | null>(null);

  const reload = () => api.listKeys().then(setKeys);

  useEffect(() => {
    void reload();
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Налаштування</h1>
        <p className="mt-1 text-sm text-slate-500">API-ключі та глобальні дефолти генерації</p>
      </div>

      <ApiKeysCard keys={keys} onChange={() => void reload()} />
      <QueueCard />
      <GenerationConfig />
    </div>
  );
}

function ApiKeysCard({ keys, onChange }: { keys: ApiKeyDto[] | null; onChange: () => void }) {
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="API-ключі"
      hint="Ліміти й блокування після 429 рахуються окремо на кожен ключ. Один ключ — дефолтний: ним оплачується все, для чого не вибрано інший у проєкті чи в дії. Batch вмикається окремо і лише на платному ключі."
    >
      <div className="space-y-4">
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
              <KeyRow key={key.id} apiKey={key} onChange={onChange} />
            ))}
          </div>
        )}

        {adding ? (
          <AddKeyForm
            hasKeys={(keys?.length ?? 0) > 0}
            onDone={() => {
              setAdding(false);
              onChange();
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Додати ключ
          </Button>
        )}
      </div>
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

  async function toggleBatch() {
    setBusy(true);
    try {
      await api.updateKey(apiKey.id, { batchEnabled: !apiKey.batchEnabled });
      onChange();
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
        {apiKey.isDefault && <Badge tone="green">дефолтний</Badge>}
        {apiKey.batchEnabled && (
          <Badge tone="amber">
            <span title="Довгі задачі йдуть у batch: −50% ціни, відповідь до 24 год">batch</span>
          </Badge>
        )}
        {!apiKey.enabled && <Badge tone="red">вимкнено</Badge>}

        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            title="Batch — тариф із затримкою до 24 год за півціни. Працює лише на платному ключі."
            onClick={() => void toggleBatch()}
            disabled={busy}
          >
            <Layers className="size-4" />
            {apiKey.batchEnabled ? 'Вимкнути batch' : 'Увімкнути batch'}
          </Button>
          {!apiKey.isDefault && (
            <Button variant="secondary" onClick={() => void makeDefault()} disabled={busy}>
              <Star className="size-4" />
              Зробити дефолтним
            </Button>
          )}
          <Button variant="secondary" onClick={() => void verify()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Перевірити
          </Button>
          <button
            type="button"
            aria-label="Видалити"
            onClick={() => void remove()}
            className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="size-4" />
          </button>
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
              .map((b) => `${b.model} до ${new Date(b.blockedUntil).toLocaleTimeString('uk-UA')}`)
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

function AddKeyForm({
  hasKeys,
  onDone,
  onCancel,
}: {
  hasKeys: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  // The first key has to be the default, otherwise nothing can generate.
  const [isDefault, setIsDefault] = useState(!hasKeys);
  const [batchEnabled, setBatchEnabled] = useState(false);
  const [rpmLimit, setRpmLimit] = useState('');
  const [dailyBudget, setDailyBudget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.createKey({
        provider: 'gemini',
        label,
        secret,
        isDefault,
        batchEnabled,
        enabled: true,
        rpmLimit: rpmLimit ? Number(rpmLimit) : null,
        dailyRequestBudget: dailyBudget ? Number(dailyBudget) : null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося додати ключ');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Назва">
          <Input value={label} placeholder="Global Gemini" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Ключ">
          <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
        </Field>
        <Field label="Роль" hint="Дефолтним може бути лише один ключ; попередній стане звичайним.">
          <label className="flex items-center gap-2 py-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              disabled={!hasKeys}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            Дефолтний ключ
          </label>
          <label className="flex items-center gap-2 py-1 text-sm">
            <input
              type="checkbox"
              checked={batchEnabled}
              onChange={(e) => setBatchEnabled(e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            Дозволити batch (−50% ціни, до 24 год)
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
        <Button
          onClick={() => void submit()}
          disabled={busy || !label || !secret}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Додати
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Скасувати
        </Button>
      </div>
    </div>
  );
}
