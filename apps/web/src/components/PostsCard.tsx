import type { PostDto, PostsPage, ProjectDto } from '@tcf/shared';
import {
  AlertCircle,
  Check,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Button, Card, Notice, Textarea } from './ui';

const STATUS_LABEL: Record<string, { text: string; tone: 'neutral' | 'green' | 'amber' | 'red' }> = {
  planned: { text: 'заплановано', tone: 'neutral' },
  generating: { text: 'генерується', tone: 'amber' },
  ready: { text: 'готовий', tone: 'green' },
  awaiting_approval: { text: 'чекає апруву', tone: 'amber' },
  publishing: { text: 'публікується', tone: 'amber' },
  published: { text: 'опубліковано', tone: 'green' },
  failed: { text: 'помилка', tone: 'red' },
  skipped: { text: 'пропущено', tone: 'neutral' },
};

/** Telegram truncates a photo caption here; longer text needs a second message. */
const CAPTION_LIMIT = 1024;

export function PostsCard({ project }: { project: ProjectDto }) {
  const [page, setPage] = useState<PostsPage | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const reload = useCallback(async () => setPage(await api.listPosts(project.id)), [project.id]);

  useEffect(() => {
    void reload();
    // Generation happens in the background; without polling the card would sit
    // on "генерується" until the operator reloads by hand.
    const timer = setInterval(() => void reload(), 8_000);
    return () => clearInterval(timer);
  }, [reload]);

  return (
    <Card
      title="Пости"
      hint={
        project.postsBuffer === 0
          ? 'Буфер вимкнено: пост готується в момент слоту.'
          : `Планувальник тримає ${project.postsBuffer} слот(и) наперед; генерація стартує за ${project.leadTimeMinutes} хв до публікації.`
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {page &&
            Object.entries(page.counts).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1.5 text-sm">
                <Badge tone={STATUS_LABEL[status]?.tone ?? 'neutral'}>
                  {STATUS_LABEL[status]?.text ?? status}
                </Badge>
                <strong>{count}</strong>
              </span>
            ))}
          <Button variant="secondary" className="ml-auto" onClick={() => void reload()}>
            <RefreshCw className="size-4" />
            Оновити
          </Button>
        </div>

        {!page ? (
          <div className="flex justify-center py-6 text-slate-400">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : page.posts.length === 0 ? (
          <p className="text-sm text-slate-500">
            Постів ще немає. Активуйте проєкт — планувальник створить слоти на найближчі дні.
          </p>
        ) : (
          <div className="space-y-2">
            {page.posts.map((post) => (
              <PostRow
                key={post.id}
                post={post}
                timezone={project.timezone}
                expanded={openId === post.id}
                onToggle={() => setOpenId(openId === post.id ? null : post.id)}
                onChanged={() => void reload()}
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function PostRow({
  post,
  timezone,
  expanded,
  onToggle,
  onChanged,
}: {
  post: PostDto;
  timezone: string;
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

  const label = STATUS_LABEL[post.status] ?? { text: post.status, tone: 'neutral' as const };
  const slot = new Date(post.scheduledAt).toLocaleString('uk-UA', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

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
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-slate-50"
      >
        <Badge tone={label.tone}>{label.text}</Badge>
        <span className="font-mono text-xs text-slate-500">{slot}</span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {post.topicTitle ?? <span className="text-slate-400">тему ще не обрано</span>}
        </span>
        {post.generation.model && (
          <span className="text-xs text-slate-400">{post.generation.model}</span>
        )}
        {post.imageKind === 'svg_fallback' && <Badge tone="amber">резервна схема</Badge>}
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
          {post.error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {post.error}
            </div>
          )}

          {post.hasImage && (
            <div className="space-y-1.5">
              <img
                src={`/api/posts/${post.id}/image?v=${encodeURIComponent(post.updatedAt)}`}
                alt=""
                className="w-full rounded-lg border border-slate-200"
              />
              <p className="text-xs text-slate-500">
                {post.imageKind === 'svg_fallback'
                  ? 'Резервна схема — модель не дала валідного SVG'
                  : post.imageKind === 'image_model'
                    ? 'Згенеровано image-моделлю'
                    : 'SVG-схема від моделі'}
              </p>
            </div>
          )}

          {post.status === 'published' ? (
            <Notice>
              Текст стерто після публікації — у Telegram він уже є, а тут лишається лише лінк.
            </Notice>
          ) : post.textHtml === null ? (
            <p className="text-sm text-slate-500">Текст ще не згенеровано.</p>
          ) : (
            <>
              <Textarea
                rows={12}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className={overCaption ? 'text-amber-600' : 'text-slate-500'}>
                  {length} символів
                  {overCaption && ` — понад ${CAPTION_LIMIT}, піде окремим повідомленням під фото`}
                </span>
                {post.generation.removedTags.length > 0 && (
                  <span className="text-slate-500">
                    санітайзер прибрав: {post.generation.removedTags.join(', ')}
                  </span>
                )}
              </div>
            </>
          )}

          {post.status !== 'published' && (
            <div className="flex flex-wrap gap-2">
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
