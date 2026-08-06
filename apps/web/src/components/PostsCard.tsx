import { TELEGRAM_CAPTION_LIMIT, type LogEntry, type PostDto, type PostsPage, type ProjectDto } from '@tcf/shared';
import {
  AlertCircle,
  Check,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type LaunchResult } from '../api/client';
import { formatDateTime } from '../lib/time';
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
    hint: 'Час публікації заброньовано, до моделі ще ніхто не звертався. Генерація стартує за «запас часу» до слоту — а якщо тему ще не взято з банку, вона візьметься тоді ж.',
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


/**
 * Statuses in which a post is supposed to be fully assembled.
 *
 * Before that, missing text is the normal state of affairs and flagging it
 * would light up the whole list; after publishing the content is deliberately
 * gone (ADR 0002) and only the permalink remains.
 */
const CONTENT_EXPECTED: string[] = ['ready', 'awaiting_approval', 'publishing'];

/** Sentinel for the cross-status filter; no post ever has this as a status. */
const PROBLEM_FILTER = '__problems__';

/**
 * A post is "проблемний" when a human has to do something about it.
 *
 * Not the same as `failed`: a post sitting in `ready` with no image is on
 * course to publish a format the channel never uses, and nothing in the status
 * chips says so.
 */
function isProblem(post: PostDto, imageExpected: boolean): boolean {
  if (post.status === 'failed' || post.status === 'skipped') return true;
  if (post.error) return true;
  if (!CONTENT_EXPECTED.includes(post.status)) return false;
  return post.textHtml === null || (imageExpected && !post.hasImage);
}

/** Text and picture at a glance: present, missing, or not applicable. */
function ContentIcons({ post, imageExpected }: { post: PostDto; imageExpected: boolean }) {
  if (post.status === 'idea' || post.status === 'planned') return null;

  const expected = CONTENT_EXPECTED.includes(post.status);
  const published = post.status === 'published';

  const textOk = published ? true : post.textHtml !== null;
  const imageOk = published ? true : post.hasImage;

  return (
    <span className="flex items-center gap-1.5">
      <Mark
        ok={textOk}
        warn={expected && !textOk}
        title={
          published
            ? 'Опубліковано: локальний текст стерто, лишився лінк'
            : textOk
              ? 'Текст готовий'
              : 'Тексту немає'
        }
      >
        <FileText className="size-3.5" />
      </Mark>
      {imageExpected && (
        <Mark
          ok={imageOk}
          warn={expected && !imageOk}
          title={
            published
              ? 'Опубліковано: зображення стерто, лишився лінк'
              : imageOk
                ? 'Зображення готове'
                : 'Зображення немає'
          }
        >
          <ImageIcon className="size-3.5" />
        </Mark>
      )}
    </span>
  );
}

function Mark({
  ok,
  warn,
  title,
  children,
}: {
  ok: boolean;
  warn: boolean;
  title: string;
  children: React.ReactNode;
}) {
  const tone = warn ? 'text-amber-600' : ok ? 'text-slate-400' : 'text-slate-300';
  return (
    <span title={title} className={`relative flex items-center ${tone}`}>
      {children}
      {!ok && <span className="absolute inset-x-0 top-1/2 h-px rotate-[-20deg] bg-current" />}
    </span>
  );
}

export function PostsCard({ project }: { project: ProjectDto }) {
  const [page, setPage] = useState<PostsPage | null>(null);
  // `?post=<id>` arrives from the queue, where a job names the post it works on.
  // Opening it is the whole point of following that link, so the id seeds the
  // expanded row and clears the filters that would have hidden it.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedId = searchParams.get('post');
  const [openId, setOpenId] = useState<string | null>(linkedId);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!linkedId) return;
    setOpenId(linkedId);
    setStatusFilter(null);
    setQuery('');
  }, [linkedId]);

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

  const imageExpected = project.imageMode !== 'none';

  const problems = useMemo(
    () => (page?.posts ?? []).filter((post) => isProblem(post, imageExpected)),
    [page, imageExpected],
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base =
      statusFilter === PROBLEM_FILTER ? problems : (page?.posts ?? []);
    return base.filter((post) => {
      // The post someone followed a link to is always in the list, whatever the
      // filters say — arriving at «під фільтр не потрапив жоден пост» after
      // clicking a direct link is the opposite of what the link promised.
      if (post.id === linkedId) return true;
      if (statusFilter && statusFilter !== PROBLEM_FILTER && post.status !== statusFilter) {
        return false;
      }
      if (!needle) return true;
      return (post.topicTitle ?? '').toLowerCase().includes(needle);
    });
  }, [page, problems, statusFilter, query, linkedId]);

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
          {/* Problems cut across statuses on purpose: a `ready` post with no
              image is heading for a broken publication, and no status chip
              would ever have shown it. */}
          {problems.length > 0 && (
            <button
              type="button"
              title="Пости, які не поїдуть як слід: помилка, пропущений слот, або немає тексту чи зображення там, де вони вже мають бути."
              onClick={() =>
                setStatusFilter(statusFilter === PROBLEM_FILTER ? null : PROBLEM_FILTER)
              }
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                statusFilter === PROBLEM_FILTER
                  ? 'bg-red-600 text-white'
                  : 'bg-red-100 text-red-700 hover:bg-red-200'
              }`}
            >
              проблемні
              <strong>{problems.length}</strong>
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
                onToggle={() => {
                  const next = openId === post.id ? null : post.id;
                  setOpenId(next);
                  // The address should stop pointing at a post the operator has
                  // closed; otherwise a reload reopens it forever.
                  if (linkedId && next !== linkedId) setSearchParams({}, { replace: true });
                }}
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
    ? formatDateTime(post.scheduledAt, { timezone: project.timezone })
    : 'без слоту';

  /** Nothing has been asked of a model yet — the row is only a subject. */
  const isIdea = post.status === 'idea';
  const length = post.generation.visibleLength ?? 0;
  // Two different thresholds, and both matter: what the project asked the model
  // for, and where Telegram stops accepting a caption.
  const overTarget = length > project.postMaxChars;
  const overCaption = length > TELEGRAM_CAPTION_LIMIT;

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
        {/*
          Wrapped, not truncated. A subject is the only thing that says what the
          post *is*, and the row cut it off at the width of the column with no
          way to see the rest — including in the expanded view, where there was
          room for it all along.
        */}
        <span className="min-w-0 flex-1 text-sm">
          {post.topicTitle ?? (
            <span className="text-slate-400">тему візьме з банку перед генерацією</span>
          )}
        </span>

        <ContentIcons post={post} imageExpected={project.imageMode !== 'none'} />
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
          {post.status === 'published' || isIdea ? null : post.textHtml === null ? (
            <p className="text-sm text-slate-500">Текст ще не згенеровано.</p>
          ) : (
            <>
              <Textarea
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="font-mono text-xs"
              />
              <p className={`text-xs ${overTarget ? 'text-amber-600' : 'text-slate-500'}`}>
                {length} символів із {project.postMaxChars}
                {overCaption && ` — понад ${TELEGRAM_CAPTION_LIMIT}, піде окремим повідомленням під фото`}
              </p>
            </>
          )}

          {/*
            An idea has been through nothing: no model call, no prompt version,
            no illustration, no journal. Showing those panels full of dashes
            invited the reader to look for information that cannot exist yet.
          */}
          {!isIdea && (
            <>
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
            </>
          )}

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

