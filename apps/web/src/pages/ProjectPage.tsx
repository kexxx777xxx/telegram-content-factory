import type { ProjectDto, TelegramCheck } from '@tcf/shared';
import { AlertCircle, ArrowLeft, Check, Loader2, PlugZap, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { GenerationConfig } from '../components/GenerationConfig';
import {
  ProjectForm,
  emptyForm,
  formFromProject,
  toCreatePayload,
  toUpdatePayload,
  type ProjectFormValue,
} from '../components/ProjectForm';
import { Button, Card, Input, Notice } from '../components/ui';

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const navigate = useNavigate();

  const [project, setProject] = useState<ProjectDto | null>(null);
  const [form, setForm] = useState<ProjectFormValue>(emptyForm);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isNew || !id) return;
    api
      .getProject(id)
      .then((loaded) => {
        setProject(loaded);
        setForm(formFromProject(loaded));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Помилка'))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (isNew) {
        const created = await api.createProject(toCreatePayload(form));
        navigate(`/projects/${created.id}`, { replace: true });
      } else if (id) {
        const updated = await api.updateProject(id, toUpdatePayload(form));
        setProject(updated);
        setForm(formFromProject(updated));
        setSaved(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося зберегти');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-xl font-semibold">{isNew ? 'Новий проєкт' : project?.name}</h1>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      <ProjectForm value={form} onChange={setForm} mode={isNew ? 'create' : 'edit'} />

      {!isNew && project && <TelegramCard project={project} />}

      {!isNew && project && <GenerationConfig projectId={project.id} />}

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          {isNew ? 'Створити' : 'Зберегти'}
        </Button>
        {saved && (
          <span className="flex items-center gap-1.5 text-sm text-emerald-600">
            <Check className="size-4" />
            Збережено
          </span>
        )}
      </div>

      {!isNew && project && <DangerZone project={project} />}
    </div>
  );
}

/**
 * Verification is a separate action rather than part of save: it makes live
 * calls to Telegram, and its result is advisory — a project can legitimately
 * be stored before the bot has been added to the channel.
 */
function TelegramCard({ project }: { project: ProjectDto }) {
  const [check, setCheck] = useState<TelegramCheck | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    try {
      setCheck(await api.verifyTelegram(project.id));
    } catch (err) {
      setCheck({
        ok: false,
        bot: null,
        chat: null,
        canPost: false,
        problems: [err instanceof Error ? err.message : 'Помилка перевірки'],
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Підключення каналу"
      hint="Перевіряє токен, доступ до каналу і право публікувати — до того, як цього потребуватиме перший слот."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-500">Канал:</span>
          <code className="rounded bg-slate-100 px-2 py-0.5 text-xs">{project.telegramChannelId}</code>
          <span className="text-slate-500">Токен:</span>
          <code className="rounded bg-slate-100 px-2 py-0.5 text-xs">
            {project.botTokenMask ?? 'не задано'}
          </code>
        </div>

        <Button variant="secondary" onClick={() => void verify()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          Перевірити підключення
        </Button>

        {check && (
          <div className="space-y-2">
            {check.ok ? (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <Check className="mt-0.5 size-4 shrink-0" />
                <div>
                  Підключено. Бот{check.bot?.username ? ` @${check.bot.username}` : ''} може
                  публікувати в «{check.chat?.title ?? project.telegramChannelId}».
                  {check.chat?.username && (
                    <>
                      {' '}
                      Публічний канал — лінки на пости будуть у вигляді{' '}
                      <code className="text-xs">t.me/{check.chat.username}/…</code>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {check.problems.map((problem, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                  >
                    <X className="mt-0.5 size-4 shrink-0" />
                    {problem}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function DangerZone({ project }: { project: ProjectDto }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await api.deleteProject(project.id);
      navigate('/', { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Небезпечна зона">
      <div className="space-y-3">
        <Notice tone="red">
          Видалення прибере проєкт разом з усіма темами, постами та джобами. Уже опубліковані пости
          в Telegram залишаться — але їх історія й лінки зникнуть звідси назавжди.
        </Notice>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-56">
            <span className="text-sm text-slate-600">
              Введіть <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{project.slug}</code>{' '}
              для підтвердження
            </span>
            <Input
              value={confirm}
              className="mt-1.5"
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          <Button
            variant="danger"
            disabled={confirm !== project.slug || busy}
            onClick={() => void remove()}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Видалити проєкт
          </Button>
        </div>
      </div>
    </Card>
  );
}
