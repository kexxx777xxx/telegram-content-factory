import {
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
  type ApiKeyDto,
  type ProjectDto,
  type ProjectInput,
  type ProjectUpdate,
  type Schedule,
} from '@tcf/shared';
import { Loader2, PlayCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ScheduleEditor } from './ScheduleEditor';
import { Button, Card, Field, Input, keyName, Notice, Select, Textarea, VarTag } from './ui';

export interface ProjectFormValue {
  name: string;
  slug: string;
  status: ProjectInput['status'];
  timezone: string;
  language: string;
  persona: string;
  imageStyle: string;
  hashtags: string;
  telegramChannelId: string;
  telegramBotToken: string;
  adminChatId: string;
  apiKeyId: string;
  imageMode: ProjectInput['imageMode'];
  publishMode: ProjectInput['publishMode'];
  postsBuffer: number;
  topicsBufferMin: number;
  leadTimeMinutes: number;
  missPolicy: ProjectInput['missPolicy'];
  postMaxChars: number;
  batchMode: ProjectInput['batchMode'];
  logEnabled: boolean;
  logRetentionDays: number;
  schedule: Schedule;
}

export function emptyForm(): ProjectFormValue {
  return {
    name: '',
    slug: '',
    status: 'paused',
    timezone: 'Europe/Kyiv',
    language: 'uk',
    persona: '',
    imageStyle: '',
    hashtags: '',
    telegramChannelId: '',
    telegramBotToken: '',
    adminChatId: '',
    apiKeyId: '',
    imageMode: 'svg',
    publishMode: 'auto',
    postsBuffer: 3,
    topicsBufferMin: 10,
    leadTimeMinutes: 180,
    missPolicy: 'publish_late',
    postMaxChars: TELEGRAM_CAPTION_LIMIT,
    batchMode: 'partial',
    logEnabled: false,
    logRetentionDays: 7,
    schedule: { mode: 'slots', slots: ['09:00', '18:00'], weekdays: [] },
  };
}

export function formFromProject(project: ProjectDto): ProjectFormValue {
  return {
    name: project.name,
    slug: project.slug,
    status: project.status,
    timezone: project.timezone,
    language: project.language,
    persona: project.persona,
    imageStyle: project.imageStyle,
    hashtags: project.hashtags.join(', '),
    telegramChannelId: project.telegramChannelId,
    // Never prefilled: the server only ever returns a mask.
    telegramBotToken: '',
    adminChatId: project.adminChatId ?? '',
    apiKeyId: project.apiKeyId ?? '',
    imageMode: project.imageMode,
    publishMode: project.publishMode,
    postsBuffer: project.postsBuffer,
    topicsBufferMin: project.topicsBufferMin,
    leadTimeMinutes: project.leadTimeMinutes,
    missPolicy: project.missPolicy,
    postMaxChars: project.postMaxChars,
    batchMode: project.batchMode,
    logEnabled: project.logEnabled,
    logRetentionDays: project.logRetentionDays,
    schedule: project.schedule,
  };
}

/**
 * Shape the form into what the API expects. Hashtags are edited as free text.
 *
 * The token differs by mode: on create an empty field must be omitted (the
 * schema demands ≥20 chars when present), while on update an empty string is
 * meaningful — it says "keep the stored one".
 */
export function toCreatePayload(form: ProjectFormValue): ProjectInput {
  const token = form.telegramBotToken.trim();
  return {
    ...common(form),
    slug: form.slug.trim(),
    ...(token ? { telegramBotToken: token } : {}),
  };
}

export function toUpdatePayload(form: ProjectFormValue): ProjectUpdate {
  return { ...common(form), telegramBotToken: form.telegramBotToken.trim() };
}

function common(form: ProjectFormValue) {
  return {
    name: form.name,
    status: form.status,
    timezone: form.timezone,
    language: form.language,
    persona: form.persona,
    imageStyle: form.imageStyle,
    hashtags: form.hashtags
      .split(/[,\s]+/)
      .map((tag) => tag.trim().replace(/^#/, ''))
      .filter(Boolean)
      .map((tag) => `#${tag}`),
    telegramChannelId: form.telegramChannelId.trim(),
    adminChatId: form.adminChatId.trim() || null,
    apiKeyId: form.apiKeyId || null,
    imageMode: form.imageMode,
    publishMode: form.publishMode,
    postsBuffer: form.postsBuffer,
    topicsBufferMin: form.topicsBufferMin,
    leadTimeMinutes: form.leadTimeMinutes,
    missPolicy: form.missPolicy,
    postMaxChars: form.postMaxChars,
    batchMode: form.batchMode,
    logEnabled: form.logEnabled,
    logRetentionDays: form.logRetentionDays,
    schedule: sortSchedule(form.schedule),
  };
}

/**
 * Slots are stored in the order the operator typed them, which turns into
 * `09:00, 18:00, 12:00` the moment one is added. Sorting on save is enough:
 * reordering while typing would move the field out from under the cursor.
 */
function sortSchedule(schedule: Schedule): Schedule {
  if (schedule.mode !== 'slots') return schedule;
  return { ...schedule, slots: [...schedule.slots].sort() };
}

function slugify(name: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z',
    и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'shch', ь: '', ю: 'iu', я: 'ia',
  };
  return name
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Kyiv', 'Europe/Warsaw', 'Europe/London', 'UTC'];
  }
})();

/**
 * Which key actually pays for this project, and what it can do.
 *
 * The project either names a key or inherits the default one; batch — the
 * half-price tier the buffers exist to exploit — works on a paid key only. Left
 * unsaid, a project with generous buffers on a free key looks configured and
 * silently generates everything synchronously at full price.
 */
function effectiveKey(keys: ApiKeyDto[], apiKeyId: string): ApiKeyDto | null {
  return keys.find((k) => k.id === apiKeyId) ?? keys.find((k) => k.isDefault) ?? null;
}

export type ProjectFormSection =
  | 'basics'
  | 'voice'
  | 'schedule'
  | 'buffers'
  | 'generation'
  | 'models'
  | 'log'
  | 'telegram'
  | 'all';

export function ProjectForm({
  value,
  onChange,
  mode,
  section = 'all',
  onFillBuffer,
}: {
  value: ProjectFormValue;
  onChange: (next: ProjectFormValue) => void;
  mode: 'create' | 'edit';
  /** Which cards to render; the project page shows one group per tab. */
  section?: ProjectFormSection;
  /** Present only for a saved project: planning needs an id. */
  onFillBuffer?: () => Promise<{ postsPlanned: number; jobsEnqueued: number }>;
}) {
  const [slugTouched, setSlugTouched] = useState(mode === 'edit');
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [defaultStyle, setDefaultStyle] = useState<string | null>(null);

  useEffect(() => {
    void api.listKeys().then(setKeys);
    // What an empty style field actually falls back to. Fetched rather than
    // copied into the bundle: a constant duplicated here is a constant that
    // will disagree with the server on the day someone changes it.
    void api.getSettings().then((s) => setDefaultStyle(s.defaultStyle || s.builtinStyle));
  }, []);

  const payingKey = effectiveKey(keys, value.apiKeyId);
  const set = <K extends keyof ProjectFormValue>(key: K, next: ProjectFormValue[K]) =>
    onChange({ ...value, [key]: next });

  const shows = (name: Exclude<ProjectFormSection, 'all'>) =>
    section === 'all' || section === name;

  return (
    <div className="space-y-6">
      {shows('basics') && (
      <Card title="Основне">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Назва">
            <Input
              value={value.name}
              placeholder="Системна архітектура"
              onChange={(e) => {
                const name = e.target.value;
                onChange({
                  ...value,
                  name,
                  slug: slugTouched ? value.slug : slugify(name),
                });
              }}
            />
          </Field>

          <Field
            label="Slug"
            hint={mode === 'edit' ? 'Незмінний після створення.' : 'Латиниця, цифри, дефіси.'}
          >
            <Input
              value={value.slug}
              disabled={mode === 'edit'}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value);
              }}
            />
          </Field>

          <Field label="Часовий пояс" hint="Усі слоти рахуються в ньому.">
            <Input
              list="tz-list"
              value={value.timezone}
              onChange={(e) => set('timezone', e.target.value)}
            />
            <datalist id="tz-list">
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </Field>
        </div>
      </Card>
      )}

      {shows('voice') && (
      <Card
        title="Голос каналу"
        hint="Ці поля підставляються в промпти під показаними назвами змінних."
      >
        <div className="space-y-4">
          <Field
            label="Персона"
            hint={
              <>
                Хто пише і як. Підставляється як <VarTag name="persona" />.
              </>
            }
          >
            <Textarea
              rows={4}
              value={value.persona}
              onChange={(e) => set('persona', e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Мова"
              hint={
                <>
                  Код мови, напр. uk. Підставляється як <VarTag name="language" />.
                </>
              }
            >
              <Input value={value.language} onChange={(e) => set('language', e.target.value)} />
            </Field>
            <Field
              label="Хештеги"
              hint={
                <>
                  Через кому, решітка не обовʼязкова. Підставляється як <VarTag name="hashtags" />.
                </>
              }
            >
              <Input
                value={value.hashtags}
                placeholder="архітектура, мікросервіси"
                onChange={(e) => set('hashtags', e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Стиль ілюстрацій"
            hint={
              <>
                Візуальна мова схем і зображень; підставляється як <VarTag name="style" />. Порожнє
                поле бере стиль із Налаштувань: {defaultStyle ?? '…'}
              </>
            }
          >
            <Textarea
              rows={2}
              value={value.imageStyle}
              placeholder={defaultStyle ?? ''}
              onChange={(e) => set('imageStyle', e.target.value)}
            />
          </Field>
        </div>
      </Card>
      )}

      {shows('telegram') && (
      <Card title="Telegram">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Канал" hint="@username каналу або числовий -100… id.">
            <Input
              value={value.telegramChannelId}
              placeholder="@my_channel"
              onChange={(e) => set('telegramChannelId', e.target.value)}
            />
          </Field>

          <Field
            label="Токен бота"
            hint={
              mode === 'edit'
                ? 'Порожнє поле — залишити збережений токен.'
                : 'Отримується у @BotFather.'
            }
          >
            <Input
              type="password"
              autoComplete="off"
              value={value.telegramBotToken}
              placeholder={mode === 'edit' ? '••••••' : '123456789:AA…'}
              onChange={(e) => set('telegramBotToken', e.target.value)}
            />
          </Field>

          <Field
            label="Адмін-чат"
            hint="Куди слати алерти й картки апруву. Необовʼязково."
          >
            <Input
              value={value.adminChatId}
              placeholder="-1001234567890"
              onChange={(e) => set('adminChatId', e.target.value)}
            />
          </Field>
        </div>
      </Card>
      )}

      {shows('schedule') && (
      <Card title="Розклад" hint="Час у поясі проєкту. Після збереження слоти сортуються.">
        <ScheduleEditor
          value={value.schedule}
          timezone={value.timezone}
          onChange={(schedule) => set('schedule', schedule)}
        />
      </Card>
      )}

      {shows('models') && (
      <Card
        title="Ключ проєкту"
        hint="Оплачує все, для чого не вибрано окремий ключ у конкретній дії нижче. Вибраний номер закріплюється: якщо дефолтним у налаштуваннях стане інший ключ, проєкт лишиться на своєму."
      >
        <Field label="API-ключ">
          <Select value={value.apiKeyId} onChange={(e) => set('apiKeyId', e.target.value)}>
            <option value="">Дефолтний (який позначено в налаштуваннях)</option>
            {keys
              .filter((k) => k.enabled)
              .map((k) => (
                <option key={k.id} value={k.id}>
                  {keyName(k)}
                </option>
              ))}
          </Select>
        </Field>
      </Card>
      )}

      {shows('generation') && (
      <Card title="Публікація">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ілюстрація">
            <Select
              value={value.imageMode}
              onChange={(e) => set('imageMode', e.target.value as never)}
            >
              <option value="svg">SVG-схема</option>
              <option value="image_model">Image-модель</option>
              <option value="none">Без зображення</option>
            </Select>
          </Field>

          <Field label="Режим публікації" hint="«Після апруву» шле картку в адмін-чат і чекає на підтвердження, а не публікує сам.">
            <Select
              value={value.publishMode}
              onChange={(e) => set('publishMode', e.target.value as never)}
            >
              <option value="auto">Автоматично</option>
              <option value="approval">Після апруву</option>
            </Select>
          </Field>

          <Field
            label="Довжина поста, символів"
            hint={
              <>
                Скільки символів просити в моделі; підставляється в промпт як{' '}
                <VarTag name="maxChars" />. До {TELEGRAM_CAPTION_LIMIT} текст іде підписом під фото;
                довший Telegram підписом не приймає, тож поїде окремим повідомленням одразу за
                зображенням.
              </>
            }
          >
            <Input
              type="number"
              min={200}
              max={TELEGRAM_MESSAGE_LIMIT}
              className="max-w-32"
              value={value.postMaxChars}
              onChange={(e) =>
                set(
                  'postMaxChars',
                  Math.min(TELEGRAM_MESSAGE_LIMIT, Math.max(200, Number(e.target.value) || 200)),
                )
              }
            />
          </Field>
        </div>

        {value.postMaxChars > TELEGRAM_CAPTION_LIMIT && (
          <Notice>
            Понад {TELEGRAM_CAPTION_LIMIT} символів — пост виходитиме двома повідомленнями: фото, а
            під ним текст. Лінк на пост і далі веде на фото.
          </Notice>
        )}
      </Card>
      )}

      {shows('buffers') && (
      <Card
        title="Буфери"
        hint="Скільки роботи система робить наперед і що робити зі слотом, який не встиг."
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Буфер постів" hint="Скільки слотів готувати наперед.">
              <Input
                type="number"
                min={0}
                value={value.postsBuffer}
                onChange={(e) => set('postsBuffer', Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>

            <Field label="Мінімум тем у банку" hint="Нижче цього числа теми доповнюються.">
              <Input
                type="number"
                min={0}
                value={value.topicsBufferMin}
                onChange={(e) => set('topicsBufferMin', Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>

            <Field label="Запас часу, хвилин" hint="За скільки до слоту починати генерацію.">
              <Input
                type="number"
                min={0}
                disabled={value.postsBuffer === 0}
                value={value.leadTimeMinutes}
                onChange={(e) => set('leadTimeMinutes', Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>

            <Field label="Якщо пост не встиг" hint="Стосується слота, який настав, а пост ще не готовий.">
              <Select
                value={value.missPolicy}
                onChange={(e) => set('missPolicy', e.target.value as never)}
              >
                <option value="publish_late">Опублікувати із запізненням</option>
                <option value="skip">Пропустити слот</option>
              </Select>
            </Field>

            <Field
              label="Використання batch"
              hint={
                <>
                  Batch — половина ціни, відповідь до 24 годин. Саме заради нього й існує буфер:
                  робота, яка може почекати добу, коштує вдвічі менше.
                  <span className="mt-1 block">
                    <b>Частковий</b> — батчиться те, за що платить ключ із увімкненим batch, решта
                    йде звичайним шляхом. <b>Лише batch</b> — слот, який не вдалося замовити
                    дешево, лишається порожнім замість генерації за повною ціною.{' '}
                    <b>Вимкнено</b> — усе синхронно.
                  </span>
                  <span className="mt-1 block">
                    Ручний запуск і слот, до якого лишились години, завжди йдуть звичайним шляхом:
                    чекати добу вже нікуди.
                  </span>
                </>
              }
            >
              <Select
                value={value.batchMode}
                onChange={(e) => set('batchMode', e.target.value as never)}
              >
                <option value="partial">Частковий — де дозволяє ключ</option>
                <option value="batch_only">Лише batch — не генерувати за повною ціною</option>
                <option value="off">Вимкнено — усе синхронно</option>
              </Select>
            </Field>
          </div>

          {value.postsBuffer === 0 && (
            <Notice>
              <strong>Буфер 0 — режим «генерувати в момент публікації».</strong> Нічого не
              готується наперед, тож слот залежить від доступності моделі саме в цю хвилину. При
              вичерпаній квоті пост поїде із запізненням або буде пропущений — залежно від політики
              вище. Для стабільності тримайте буфер ≥ 1.
            </Notice>
          )}

          {value.topicsBufferMin === 0 && (
            <Notice>
              <strong>Банк тем вимкнено.</strong> Тема запитуватиметься в моделі безпосередньо
              перед кожним постом — це ще один виклик у критичному шляху й вищий ризик повторів.
            </Notice>
          )}

          {/*
            The buffer is what makes the half-price tier usable — work with a day
            of slack can wait for it. On a free key that saving simply does not
            exist, and nothing on this card said so: the field accepted the
            number and the project generated everything synchronously.
          */}
          {value.postsBuffer > 0 &&
            value.batchMode !== 'off' &&
            payingKey &&
            !(payingKey.tier === 'paid' && payingKey.batchEnabled) && (
              <Notice tone={value.batchMode === 'batch_only' ? 'red' : 'amber'}>
                <strong>
                  {value.batchMode === 'batch_only'
                    ? 'Режим «лише batch», а batch недоступний.'
                    : 'Буфер працює, але без економії.'}
                </strong>{' '}
                Ключ «{payingKey.label}»{' '}
                {payingKey.tier === 'paid'
                  ? 'платний, але batch на ньому не ввімкнено'
                  : 'безкоштовний, а batch доступний лише на платному плані'}
                {value.batchMode === 'batch_only'
                  ? ' — пости наперед не готуватимуться взагалі. Увімкніть batch на ключі або перемкніть режим.'
                  : ', тож теми й тексти генеруються синхронно за повною ціною.'}{' '}
                Batch вмикається в Налаштуваннях → API-ключі.
              </Notice>
            )}

          {onFillBuffer && value.postsBuffer > 0 && <FillBufferButton onFill={onFillBuffer} />}
        </div>
      </Card>
      )}

      {shows('log') && (
      <Card
        title="Налаштування журналу"
        hint="Один вимикач на все: тема, поповнення банку, кроки генерації, публікація — і повні промпти з відповідями."
      >
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={value.logEnabled}
              onChange={(e) => set('logEnabled', e.target.checked)}
              className="mt-0.5 size-4 rounded border-slate-300"
            />
            <span>
              Вести журнал
              <span className="block text-xs text-slate-500">
                Окремі перемикачі для запитів і відповідей завжди вмикали разом: промпт без
                відповіді нічого не пояснює, а відповідь без промпта — ще менше.
              </span>
            </span>
          </label>

          <Field
            label="Зберігати днів"
            hint="Старші записи прибирає щоденний prune. Самі пости це не чіпає."
          >
            <Input
              type="number"
              min={1}
              max={365}
              className="max-w-32"
              value={value.logRetentionDays}
              onChange={(e) =>
                set('logRetentionDays', Math.min(365, Math.max(1, Number(e.target.value) || 1)))
              }
            />
          </Field>

          <Notice>
            Зображення в журнал <strong>не потрапляють</strong> — лише рядок про те, яка модель
            малювала й скільки важить результат.
          </Notice>
        </div>
      </Card>
      )}
    </div>
  );
}

/**
 * Plans the missing slots on the spot instead of waiting for the next tick.
 *
 * The tick is a minute away at worst, but that is not what this button is for:
 * after raising the buffer — or after the app was down for a day — the operator
 * wants to see the queue fill up while they are still looking at it, and to
 * know how much was actually planned.
 */
function FillBufferButton({
  onFill,
}: {
  onFill: () => Promise<{ postsPlanned: number; jobsEnqueued: number }>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ postsPlanned: number; jobsEnqueued: number } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await onFill());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="secondary" disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
        Наповнити буфер зараз
      </Button>
      {result && (
        <span className="text-sm text-slate-500">
          {result.postsPlanned === 0
            ? 'Буфер уже повний — нових слотів не зʼявилось.'
            : `Заплановано слотів: ${result.postsPlanned}, поставлено джоб: ${result.jobsEnqueued}.`}
        </span>
      )}
    </div>
  );
}
