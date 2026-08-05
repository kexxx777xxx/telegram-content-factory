import type { ApiKeyDto, ProjectDto, ProjectInput, ProjectUpdate, Schedule } from '@tcf/shared';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ScheduleEditor } from './ScheduleEditor';
import { Card, Field, Input, Notice, Select, Textarea } from './ui';

export interface ProjectFormValue {
  name: string;
  slug: string;
  status: ProjectInput['status'];
  timezone: string;
  language: string;
  persona: string;
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
    schedule: form.schedule,
  };
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

export function ProjectForm({
  value,
  onChange,
  mode,
}: {
  value: ProjectFormValue;
  onChange: (next: ProjectFormValue) => void;
  mode: 'create' | 'edit';
}) {
  const [slugTouched, setSlugTouched] = useState(mode === 'edit');
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);

  useEffect(() => {
    void api.listKeys().then(setKeys);
  }, []);
  const set = <K extends keyof ProjectFormValue>(key: K, next: ProjectFormValue[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div className="space-y-6">
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

      <Card title="Голос каналу" hint="Підставляється в кожен промпт генерації тексту.">
        <div className="space-y-4">
          <Field
            label="Персона"
            hint="Хто пише і як. Наприклад: досвідчений системний архітектор, колегіальний тон, без води."
          >
            <Textarea
              rows={4}
              value={value.persona}
              onChange={(e) => set('persona', e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Мова" hint="Код мови, напр. uk.">
              <Input value={value.language} onChange={(e) => set('language', e.target.value)} />
            </Field>
            <Field label="Хештеги" hint="Через кому. Решітка не обовʼязкова.">
              <Input
                value={value.hashtags}
                placeholder="архітектура, мікросервіси"
                onChange={(e) => set('hashtags', e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Card>

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

      <Card title="Розклад">
        <ScheduleEditor
          value={value.schedule}
          timezone={value.timezone}
          onChange={(schedule) => set('schedule', schedule)}
        />
      </Card>

      <Card title="Генерація">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="API-ключ проєкту"
              hint="Оплачує все, для чого не вибрано окремий ключ у конкретній дії."
            >
              <Select value={value.apiKeyId} onChange={(e) => set('apiKeyId', e.target.value)}>
                <option value="">Дефолтний ключ</option>
                {keys
                  .filter((k) => k.enabled)
                  .map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                      {k.isDefault ? ' (дефолтний)' : ''}
                    </option>
                  ))}
              </Select>
            </Field>

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

            <Field label="Публікація">
              <Select
                value={value.publishMode}
                onChange={(e) => set('publishMode', e.target.value as never)}
              >
                <option value="auto">Автоматично</option>
                <option value="approval">Після апруву</option>
              </Select>
            </Field>

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

            <Field
              label="Запас часу, хвилин"
              hint="За скільки до слоту починати генерацію."
            >
              <Input
                type="number"
                min={0}
                disabled={value.postsBuffer === 0}
                value={value.leadTimeMinutes}
                onChange={(e) => set('leadTimeMinutes', Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>

            <Field label="Якщо пост не встиг">
              <Select
                value={value.missPolicy}
                onChange={(e) => set('missPolicy', e.target.value as never)}
              >
                <option value="publish_late">Опублікувати із запізненням</option>
                <option value="skip">Пропустити слот</option>
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
        </div>
      </Card>
    </div>
  );
}
