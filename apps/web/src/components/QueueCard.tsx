import type { ProjectDto } from '@tcf/shared';
import { Loader2, PlayCircle, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '../lib/time';
import { api, type JobDto, type JobsPage, type PurgeableStatus } from '../api/client';
import { Badge, Button, Card, Notice, Select } from './ui';

const STATUS_TONE: Record<string, 'neutral' | 'green' | 'amber' | 'red'> = {
  pending: 'neutral',
  running: 'amber',
  done: 'green',
  failed: 'amber',
  dead: 'red',
};

/** What each status means for the operator, in one sentence. */
const STATUS_HINT: Record<string, string> = {
  pending: 'Чекає свого часу; воркер візьме її, коли настане «виконати після».',
  running: 'Просто зараз у роботі у воркера.',
  done: 'Виконана. Лишається лише як слід — її можна чистити.',
  failed: 'Спроба впала, але спроби ще лишились: буде повтор із затримкою.',
  dead: 'Спроби вичерпані. Сама вже не піде — або перезапустити, або видалити.',
};

/**
 * What each job type actually does. Without it the queue reads as a list of
 * internal identifiers — accurate, and no help at all in seeing what stopped.
 */
const TYPE_LABEL: Record<string, string> = {
  generate_post: 'генерація поста',
  generate_and_publish: 'згенерувати і опублікувати',
  publish_post: 'публікація поста',
  replenish_topics: 'поповнення банку тем',
  collect_batch: 'збір batch-відповіді',
  prune: 'прибирання старих записів',
  backup: 'бекап конфігурації',
};

/** Deleting is offered only for statuses the server actually allows to delete. */
const PURGEABLE: PurgeableStatus[] = ['dead', 'failed', 'done'];

function isPurgeable(status: string): status is PurgeableStatus {
  return (PURGEABLE as string[]).includes(status);
}

/**
 * The queue as a list of things that happened, not a wall of ids.
 *
 * Two thousand dead jobs with no project, no date and no way to remove them are
 * worse than none: the counts stop meaning anything, so a *new* failure hides
 * among the old ones. Hence the three things every row now carries — whose it
 * is, when it arrived, and what to do with it — and a way to empty a status in
 * one action.
 */
export function QueueCard({ projectId }: { projectId?: string }) {
  const [page, setPage] = useState<JobsPage | null>(null);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [status, setStatus] = useState<string>('');
  const [project, setProject] = useState<string>(projectId ?? '');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setPage(await api.listJobs({ status: status || undefined, projectId: project || undefined }));
  }, [status, project]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    if (!projectId) void api.listProjects().then(setProjects);
  }, [projectId]);

  async function plan() {
    setBusy(true);
    try {
      await api.forcePlan();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function purge(target: PurgeableStatus) {
    const count = page?.counts[target] ?? 0;
    const scope = project ? ' у вибраному проєкті' : '';
    if (!confirm(`Видалити ${count} джоб зі статусом «${target}»${scope}? Дію не скасувати.`)) return;
    setBusy(true);
    try {
      await api.purgeJobs(target, project || undefined);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const shown = page?.jobs ?? [];
  const deadCount = page?.counts.dead ?? 0;

  return (
    <Card
      title="Черга"
      hint="Кожна одиниця роботи, яку система робить сама: згенерувати текст, намалювати схему, відправити пост. Планувальник додає їх щохвилини, воркери розбирають паралельно. Успішні можна чистити — вони нічого не тримають."
      actions={
        <>
          <Button variant="secondary" onClick={() => void reload()}>
            <RefreshCw className="size-4" />
            Оновити
          </Button>
          <Button variant="secondary" onClick={() => void plan()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
            Спланувати зараз
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Counts double as the status filter — they were already the first
            thing scanned, so a separate dropdown would have said it twice. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setStatus('')}
            className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
              status === '' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            усі
          </button>
          {page &&
            Object.entries(page.counts).map(([name, count]) => (
              <button
                key={name}
                type="button"
                title={STATUS_HINT[name]}
                onClick={() => setStatus(status === name ? '' : name)}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  status === name
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {name}
                <strong>{count}</strong>
              </button>
            ))}

          {!projectId && projects.length > 0 && (
            <span className="ml-auto w-56">
              <Select value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">усі проєкти</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </span>
          )}
        </div>

        {deadCount > 0 && (
          <Notice tone="red">
            <div className="flex flex-wrap items-center gap-3">
              <span>
                <strong>{deadCount}</strong> джоб вичерпали спроби й самі вже не підуть. Причина —
                в останній помилці рядка. Після виправлення їх можна перезапустити; якщо вони
                стосуються постів, яких давно немає, — видалити.
              </span>
              <Button
                variant="danger"
                className="ml-auto"
                disabled={busy}
                onClick={() => void purge('dead')}
              >
                <Trash2 className="size-4" />
                Видалити всі dead
              </Button>
            </div>
          </Notice>
        )}

        {!page ? (
          <div className="flex justify-center py-6 text-slate-400">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate-500">
            {status || project ? 'Під фільтр не потрапила жодна джоба.' : 'Черга порожня.'}
          </p>
        ) : (
          <>
            <div className="max-h-[32rem] divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200">
              {shown.map((job) => (
                <JobRow key={job.id} job={job} onChanged={() => void reload()} />
              ))}
            </div>

            {status && isPurgeable(status) && (
              <Button variant="secondary" disabled={busy} onClick={() => void purge(status)}>
                <Trash2 className="size-4" />
                Видалити всі «{status}»
                {project ? ' у вибраному проєкті' : ''}
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function JobRow({ job, onChanged }: { job: JobDto; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const canRetry = job.status === 'dead' || job.status === 'failed';

  return (
    <div className="px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>
          <span title={STATUS_HINT[job.status]}>{job.status}</span>
        </Badge>
        <span className="font-medium text-slate-700">{TYPE_LABEL[job.type] ?? job.type}</span>
        <span className="text-slate-500">
          {job.projectName ?? <span className="text-slate-400">без проєкту</span>}
        </span>
        <span className="text-slate-400">
          спроба {job.attempts}/{job.maxAttempts}
        </span>

        <span className="ml-auto flex items-center gap-1">
          {canRetry && (
            <button
              type="button"
              title="Скинути спроби й поставити в чергу знову"
              disabled={busy}
              onClick={() => void act(() => api.retryJob(job.id))}
              className="flex items-center gap-1 rounded px-2 py-1 text-slate-500 transition hover:bg-slate-100 disabled:opacity-40"
            >
              <RotateCcw className="size-3.5" />
              Ще раз
            </button>
          )}
          {isPurgeable(job.status) && (
            <button
              type="button"
              title="Видалити цю джобу"
              aria-label="Видалити"
              disabled={busy}
              onClick={() => void act(() => api.deleteJob(job.id))}
              className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </div>

      {/* Three timestamps, because they answer different questions: when it
          appeared, when something last happened to it, and when it may run. */}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-slate-400">
        <span>додано {formatDateTime(job.createdAt)}</span>
        <span>оновлено {formatDateTime(job.updatedAt)}</span>
        {job.status === 'pending' && <span>виконати після {formatDateTime(job.runAfter)}</span>}
      </div>

      {job.lastError && <p className="mt-1 break-words text-red-600">{job.lastError}</p>}
    </div>
  );
}
