import type { LogEntry, PostDto, PostsPage, ProjectDto } from '@tcf/shared';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type LaunchResult } from '../api/client';
import { formatDateTime, zoneDiffers } from '../lib/time';
import { LaunchButton } from './LaunchButton';
import { IdeaTools } from './IdeaTools';
import { Badge, Button, Card, Input, Spoiler, Textarea } from './ui';

/**
 * Status vocabulary in one place.
 *
 * The hint is not decoration: «заплановано» and «генерується» look alike from
 * outside, and the difference — whether a model has been asked anything yet —
 * decides whether waiting is the right response.
 */
const STATUS: Record<
  string,
  { text: string; tone: 'neutral' | 'green' | 'amber' | 'red'; hint: string }
> = {
  idea: {
    text: 'тема',
    tone: 'neutral',
    hint: 'Пост, у якого поки є лише «про що». Слот отримає, коли планувальник дійде до нього — або зараз, кнопкою.',
  },
  planned: {
    text: 'заплановано',
    tone: 'neutral',
    hint: 'Слот заброньовано, до моделі ще ніхто не звертався. Генерація стартує за lead time до публікації.',
  },
  generating: {
    text: 'генерується',
    tone: 'amber',
    hint: 'Просто зараз працює модель: спершу текст, потім ілюстрація.',
  },
  ready: {
    text: 'готовий',
    tone: 'green',
    hint: 'Текст і зображення лежать у буфері. Публікація — в момент слоту, без жодного виклику моделі.',
  },
  awaiting_approval: {
    text: 'чекає апруву',
    tone: 'amber',
    hint: 'Готовий, але проєкт вимагає підтвердження — картка пішла в адмін-чат.',
  },
  publishing: {
    text: 'публікується',
    tone: 'amber',
    hint: 'Відправляється в Telegram просто зараз.',
  },
  published: {
    text: 'опубліковано',
    tone: 'green',
    hint: 'Пост у каналі. Локальні текст і зображення стерто, лишився лінк.',
  },
  failed: {
    text: 'помилка',
    tone: 'red',
    hint: 'Спроби вичерпано. Причина — нижче; після виправлення пост можна перегенерувати.',
  },
  skipped: {
    text: 'пропущено',
    tone: 'neutral',
    hint: 'Пост не встиг до кінця grace-вікна, а проєкт налаштовано такі слоти пропускати.',
  },
};

/** Telegram truncates a photo caption here; longer text needs a second message. */
const CAPTION_LIMIT = 1024;

export function PostsCard({ project }: { project: ProjectDto }) {
  const [page, setPage] = useState<PostsPage | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // One request: ideas arrive in the same list, as posts with status `idea`.
  const reload = useCallback(async () => {
    setPage(await api.listPosts(project.id));
  }, [project.id]);

  useEffect(() => {
    void reload();
    // Generation happens in the background; without polling the card would sit
    // on "генерується" until the operator reloads by hand.
    const timer = setInterval(() => void reload(), 8_000);
    return () => clearInterval(timer);
  }, [reload]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (page?.posts ?? []).filter((post) => {
      if (statusFilter && post.status !== statusFilter) return false;
      if (!needle) return true;
      return (post.topicTitle ?? '').toLowerCase().includes(needle);
    });
  }, [page, statusFilter, query]);

  return (
    <Card
      title="Пости"
      hint={
        project.postsBuffer === 0
          ? 'Один список: тема — це пост, у якого поки є лише «про що». Буфер вимкнено — пост готується в момент слоту.'
          : `Один список: тема — це пост, у якого поки є лише «про що». Планувальник тримає ${project.postsBuffer} ${project.postsBuffer === 1 ? 'слот' : 'слоти'} наперед, генерація стартує за ${project.leadTimeMinutes} хв до публікації.`
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {/*
            The counts double as the filter. They were already the thing an
            operator scanned first; making them clickable removes a second
            control that would have said the same words.
          */}
          {page && Object.keys(page.counts).length > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                statusFilter === null ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              усі {page.posts.length}
            </button>
          )}
          {page &&
            Object.entries(page.counts).map(([status, count]) => (
              <button
                key={status}
                type="button"
                title={STATUS[status]?.hint}
                onClick={() => setStatusFilter(statusFilter === status ? null : status)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  statusFilter === status
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {STATUS[status]?.text ?? status}
                <strong>{count}</strong>
              </button>
            ))}
          <span className="ml-auto flex items-center gap-2">
            <LaunchButton
              label="Опублікувати зараз"
              confirm={`Опублікувати найближчий пост проєкту «${project.name}» просто зараз, не чекаючи слоту?`}
              run={() => api.publishProjectNow(project.id)}
              onDone={() => void reload()}
            />
            <Button variant="secondary" onClick={() => void reload()}>
              <RefreshCw className="size-4" />
              Оновити
            </Button>
          </span>
        </div>

        <Input
          value={query}
          placeholder="Пошук за темою…"
          onChange={(e) => setQuery(e.target.value)}
        />

        {!page ? (
          <div className="flex justify-center py-6 text-slate-400">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : page.posts.length === 0 ? (
          <p className="text-sm text-slate-500">
            Постів ще немає. Активуйте проєкт — планувальник створить слоти на найближчі дні.
          </p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-slate-500">Під фільтр не потрапив жоден пост.</p>
        ) : (
          <div className="space-y-2">
            {visible.map((post) => (
              <PostRow
                key={post.id}
                post={post}
                project={project}
                expanded={openId === post.id}
                onToggle={() => setOpenId(openId === post.id ? null : post.id)}
                onChanged={() => void reload()}
              />
            ))}
          </div>
        )}

        <IdeaTools project={project} onChanged={() => void reload()} />
      </div>
    </Card>
  );
}

function PostRow({
  post,
  project,
  expanded,
  onToggle,
  onChanged,
}: {
  post: PostDto;
  project: ProjectDto;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(post.textHtml ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(post.textHtml ?? '');
    setSaved(false);
  }, [post.textHtml]);

  const label = STATUS[post.status] ?? { text: post.status, tone: 'neutral' as const, hint: '' };
  const slot = post.scheduledAt
    ? formatDateTime(post.scheduledAt, {
        timezone: project.timezone,
        withZone: zoneDiffers(project.timezone),
      })
    : 'без слоту';

  const length = post.generation.visibleLength ?? 0;
  const overCaption = length > CAPTION_LIMIT;

  async function save() {
    setBusy(true);
    try {
      await api.updatePost(post.id, draft);
      setSaved(true);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(keepTopic: boolean) {
    setBusy(true);
    try {
      await api.regeneratePost(post.id, keepTopic);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200">
      {/*
        The row carries only what is needed every time: state, when, what about,
        and the link. Model names and sanitiser notes matter while debugging one
        post, so they moved into the expanded area rather than onto every line.
      */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        <span title={label.hint}>
          <Badge tone={label.tone}>{label.text}</Badge>
        </span>
        <span className="font-mono text-xs text-slate-500">{slot}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {post.topicTitle ?? <span className="text-slate-400">тему ще не обрано</span>}
        </span>
        {post.permalink && (
          <a
            href={post.permalink}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
          >
            <ExternalLink className="size-3.5" />
            пост
          </a>
        )}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-slate-200 px-4 py-4">
          <p className="text-xs text-slate-500">{label.hint}</p>

          {post.error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {post.error}
            </div>
          )}

          {post.hasImage && (
            <img
              src={`/api/posts/${post.id}/image?v=${encodeURIComponent(post.updatedAt)}`}
              alt=""
              className="w-full rounded-lg border border-slate-200"
            />
          )}

          {/* The `published` hint above already says the text is gone; a Notice
              repeating it added a second sentence and no second fact. */}
          {post.status === 'published' ? null : post.textHtml === null ? (
            <p className="text-sm text-slate-500">Текст ще не згенеровано.</p>
          ) : (
            <>
              <Textarea
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="font-mono text-xs"
              />
              <p className={`text-xs ${overCaption ? 'text-amber-600' : 'text-slate-500'}`}>
                {length} символів
                {overCaption && ` — понад ${CAPTION_LIMIT}, піде окремим повідомленням під фото`}
              </p>
            </>
          )}

          <Spoiler label="Як це згенеровано">
            <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[11rem_1fr]">
              <dt className="text-slate-500">Модель тексту</dt>
              <dd>{post.generation.model ?? '—'}</dd>
              <dt className="text-slate-500">Версія промпта</dt>
              <dd>{post.generation.promptVersion ?? '—'}</dd>
              <dt className="text-slate-500">Ілюстрація</dt>
              <dd>{describeImage(post.imageKind)}</dd>
              {post.generation.removedTags.length > 0 && (
                <>
                  <dt className="text-slate-500">Санітайзер прибрав</dt>
                  <dd>{post.generation.removedTags.join(', ')}</dd>
                </>
              )}
              <dt className="text-slate-500">Згенеровано</dt>
              <dd>
                {post.generation.generatedAt
                  ? formatDateTime(post.generation.generatedAt, { timezone: project.timezone })
                  : '—'}
              </dd>
            </dl>
          </Spoiler>

          <PostLog post={post} project={project} />

          {post.status !== 'published' && (
            <div className="flex flex-wrap items-center gap-2">
              {post.textHtml !== null && (
                <Button onClick={() => void save()} disabled={busy || draft === post.textHtml}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Зберегти
                </Button>
              )}
              {saved && (
                <span className="flex items-center gap-1.5 text-sm text-emerald-600">
                  <Check className="size-4" />
                  Збережено
                </span>
              )}
              <LaunchButton
                label={post.textHtml === null ? 'Згенерувати і опублікувати' : 'Опублікувати зараз'}
                confirm={
                  post.textHtml === null
                    ? 'Пост ще не готовий. Згенерувати його зараз і одразу опублікувати?'
                    : 'Опублікувати цей пост зараз, не чекаючи слоту?'
                }
                disabled={busy}
                run={() => api.publishPostNow(post.id)}
                onDone={onChanged}
              />
              <Button variant="secondary" onClick={() => void regenerate(true)} disabled={busy}>
                <RotateCcw className="size-4" />
                Перегенерувати
              </Button>
              <Button variant="secondary" onClick={() => void regenerate(false)} disabled={busy}>
                Інша тема
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function describeImage(kind: string | null): string {
  switch (kind) {
    case 'svg_fallback':
      return 'резервна схема — модель не дала валідного SVG';
    case 'image_model':
      return 'намальовано image-моделлю';
    case 'svg':
      return 'SVG-схема від моделі';
    default:
      return '—';
  }
}

export const KIND_LABEL: Record<string, string> = {
  topic_created: 'тема',
  topics_replenished: 'банк тем',
  model_request: 'запит',
  model_response: 'відповідь',
  generation_step: 'крок',
  publish: 'публікація',
  note: 'примітка',
};

/**
 * Loaded only when opened: the log is the bulkiest thing on the screen and most
 * of the time nobody looks at it.
 */
function PostLog({ post, project }: { post: PostDto; project: ProjectDto }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const off = !project.logEnabled;

  async function load() {
    if (entries || loading) return;
    setLoading(true);
    try {
      setEntries(await api.postLog(post.id));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details
      className="group rounded-lg border border-slate-200 bg-slate-50"
      onToggle={(e) => {
        if (e.currentTarget.open) void load();
      }}
    >
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900">
        <span className="inline-block transition group-open:rotate-90">▸</span> Журнал поста
        {off && <span className="ml-2 font-normal text-slate-400">(вимкнено в проєкті)</span>}
      </summary>
      <div className="space-y-2 border-t border-slate-200 px-3 py-3">
        {loading && <Loader2 className="size-4 animate-spin text-slate-400" />}
        {entries && entries.length === 0 && (
          <p className="text-xs text-slate-500">
            {off
              ? 'Журнал для цього проєкту вимкнено. Увімкніть його на вкладці «Огляд» — наступна генерація запише сюди все, що відбувалось.'
              : 'Записів немає: пост ще не генерувався після вмикання журналу.'}
          </p>
        )}
        {entries?.map((entry) => (
          <div key={entry.id} className="rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
              <Badge tone={entry.ok ? (entry.kind === 'model_request' ? 'neutral' : 'green') : 'red'}>
                {KIND_LABEL[entry.kind] ?? entry.kind}
              </Badge>
              {entry.source && <span>{entry.source === 'manual' ? 'вручну' : 'авто'}</span>}
              {entry.action && <span>{entry.action}</span>}
              {entry.model && <span className="font-mono">{entry.model}</span>}
              {entry.keyLabel && <span>ключ: {entry.keyLabel}</span>}
              {entry.durationMs !== null && <span>{entry.durationMs} мс</span>}
              {entry.inputTokens !== null && (
                <span>
                  {entry.inputTokens}→{entry.outputTokens} токенів
                </span>
              )}
              <span className="ml-auto">
                {formatDateTime(entry.createdAt, { timezone: project.timezone, timeOnly: true })}
              </span>
            </div>
            <p className="px-3 py-2 text-xs text-slate-700">{entry.message}</p>
            {entry.detail && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-slate-100 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-600">
                {entry.detail}
              </pre>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

