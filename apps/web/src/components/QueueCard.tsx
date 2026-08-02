import { Loader2, PlayCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, type JobsPage } from '../api/client';
import { Badge, Button, Card, Notice } from './ui';

const STATUS_TONE: Record<string, 'neutral' | 'green' | 'amber' | 'red'> = {
  pending: 'neutral',
  running: 'amber',
  done: 'green',
  failed: 'amber',
  dead: 'red',
};

/**
 * A working view of the queue, not the dashboard — that comes later. Its job
 * here is to answer "is anything stuck" while the pipeline is still being
 * built, which is exactly when it is hardest to tell.
 */
export function QueueCard() {
  const [page, setPage] = useState<JobsPage | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => setPage(await api.listJobs()), []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [reload]);

  async function plan() {
    setBusy(true);
    try {
      await api.forcePlan();
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const dead = page?.jobs.filter((j) => j.status === 'dead') ?? [];

  return (
    <Card title="Черга" hint="Планувальник тікає щохвилини; воркери розбирають джоби паралельно.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {page &&
            Object.entries(page.counts).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1.5 text-sm">
                <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status}</Badge>
                <strong>{count}</strong>
              </span>
            ))}
          <span className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => void reload()}>
              <RefreshCw className="size-4" />
              Оновити
            </Button>
            <Button variant="secondary" onClick={() => void plan()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
              Спланувати зараз
            </Button>
          </span>
        </div>

        {dead.length > 0 && (
          <Notice tone="red">
            {dead.length} джоб(и) вичерпали спроби. Причина в останній помилці — після виправлення
            їх можна перезапустити.
          </Notice>
        )}

        {!page ? (
          <div className="flex justify-center py-6 text-slate-400">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : page.jobs.length === 0 ? (
          <p className="text-sm text-slate-500">Черга порожня.</p>
        ) : (
          <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
            {page.jobs.slice(0, 40).map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-0"
              >
                <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>{job.status}</Badge>
                <code className="rounded bg-slate-100 px-1.5 py-0.5">{job.type}</code>
                <span className="text-slate-400">
                  спроба {job.attempts}/{job.maxAttempts}
                </span>
                {job.status === 'pending' && (
                  <span className="text-slate-400">
                    з {new Date(job.runAfter).toLocaleTimeString('uk-UA')}
                  </span>
                )}
                {job.lastError && (
                  <span className="min-w-0 flex-1 truncate text-red-600">{job.lastError}</span>
                )}
                {(job.status === 'dead' || job.status === 'failed') && (
                  <button
                    type="button"
                    onClick={() => void api.retryJob(job.id).then(() => void reload())}
                    className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-slate-500 hover:bg-slate-100"
                  >
                    <RotateCcw className="size-3.5" />
                    Ще раз
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
