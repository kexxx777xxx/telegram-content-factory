import { AlertTriangle, Ban, Clock, Loader2, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type DashboardData } from '../api/client';
import { formatDateTime, formatLocalTime, zoneDiffers } from '../lib/time';
import { Badge, Button, Card, Notice } from '../components/ui';

/**
 * Reads as "is anything about to go wrong", not "what happened".
 *
 * Buffer depth is first because it is the only number that warns *before* a
 * slot is missed; everything below it explains a problem that already exists.
 */
export function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);

  const reload = useCallback(async () => setData(await api.dashboard()), []);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [reload]);

  if (!data) {
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  const active = data.projects.filter((p) => p.status === 'active');
  const starving = active.filter((p) => p.postsBuffer > 0 && p.bufferDepth < p.postsBuffer);
  const thirsty = active.filter((p) => p.topicsBufferMin > 0 && p.freshTopics < p.topicsBufferMin);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Дашборд</h1>
        <p className="mt-1 text-sm text-slate-500">
          {active.length} активних {active.length === 1 ? 'проєкт' : 'проєктів'}
        </p>
      </div>

      {data.blocked.length > 0 && (
        <Notice>
          <strong>Заблоковані пари «ключ + модель»:</strong>{' '}
          {data.blocked
            .map(
              (b) =>
                `${b.keyLabel} / ${b.model} до ${formatLocalTime(b.blockedUntil)}`,
            )
            .join('; ')}
          . Генерація на цих моделях пропускається миттєво, доки вікно не закриється.
        </Notice>
      )}

      {starving.length > 0 && (
        <Notice>
          <strong>Буфер просів:</strong> {starving.map((p) => p.name).join(', ')}. Слот ще не
          пропущено, але запас менший за цільовий — варто глянути чергу й ліміти.
        </Notice>
      )}

      {thirsty.length > 0 && (
        <Notice>
          <strong>Мало вільних тем:</strong> {thirsty.map((p) => p.name).join(', ')}. Планувальник
          поповнить сам, якщо ланцюжок `topics` працює.
        </Notice>
      )}

      <Card
        title="Проєкти"
        hint="«Буфер» — скільки постів уже готові наперед. Поки це число більше за нуль, найближчий слот вийде навіть якщо моделі зараз недоступні; нуль означає, що пост робитиметься в останню мить."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="pb-2 font-medium">Проєкт</th>
                <th className="pb-2 font-medium">Буфер</th>
                <th className="pb-2 font-medium">Теми</th>
                <th className="pb-2 font-medium">Наступний слот</th>
                <th className="pb-2 font-medium">Остання публікація</th>
                <th className="pb-2 font-medium">Проблеми</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => {
                // Only active projects can be "behind": a paused one has an
                // empty buffer by design, and flagging it trains the eye to
                // ignore the colour that matters.
                const live = p.status === 'active';
                const bufferLow = live && p.postsBuffer > 0 && p.bufferDepth < p.postsBuffer;
                const topicsLow = live && p.topicsBufferMin > 0 && p.freshTopics < p.topicsBufferMin;
                return (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2.5">
                      <Link to={`/projects/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      {p.status !== 'active' && (
                        <Badge tone="neutral">
                          <span className="ml-2">{p.status === 'paused' ? 'пауза' : 'архів'}</span>
                        </Badge>
                      )}
                    </td>
                    <td className={`py-2.5 ${bufferLow ? 'text-amber-600' : 'text-slate-600'}`}>
                      {p.postsBuffer === 0 ? 'JIT' : `${p.bufferDepth}/${p.postsBuffer}`}
                    </td>
                    <td className={`py-2.5 ${topicsLow ? 'text-amber-600' : 'text-slate-600'}`}>
                      {p.topicsBufferMin === 0 ? 'JIT' : `${p.freshTopics}/${p.topicsBufferMin}`}
                    </td>
                    <td className="py-2.5 text-slate-600">{formatSlot(p.nextSlotAt, p.timezone)}</td>
                    <td className="py-2.5 text-slate-600">
                      {formatSlot(p.lastPublishedAt, p.timezone)}
                    </td>
                    <td className="py-2.5">
                      {p.failedPosts > 0 && <Badge tone="red">{p.failedPosts} помилок</Badge>}
                      {p.skippedPosts > 0 && (
                        <Badge tone="amber">
                          <span className="ml-1">{p.skippedPosts} пропущено</span>
                        </Badge>
                      )}
                      {p.failedPosts === 0 && p.skippedPosts === 0 && (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="SLO за 7 днів" hint="KPI «0% збоїв» із PRD недосяжний як формулювання; це те, що можна виміряти.">
          <div className="space-y-2 text-sm">
            <Row label="Опубліковано вчасно" value={data.slo.publishedOnTime} tone="green" />
            <Row label="Із запізненням" value={data.slo.publishedLate} tone="amber" />
            <Row label="Пропущено слотів" value={data.slo.skipped} tone="red" />
            <Row
              label="Резервних схем"
              value={`${data.slo.fallbackImages} з ${data.slo.totalImages}`}
              tone={data.slo.fallbackImages > 0 ? 'amber' : 'green'}
            />
          </div>
        </Card>

        <Card title="Витрати сьогодні">
          <div className="space-y-2 text-sm">
            {data.spendToday.length === 0 ? (
              <p className="text-slate-500">Ключів немає.</p>
            ) : (
              data.spendToday.map((s) => (
                <div key={s.keyLabel} className="flex items-center justify-between">
                  <span>{s.keyLabel}</span>
                  <span className="text-slate-500">
                    {s.requests}
                    {s.budget ? `/${s.budget}` : ''} запитів · {s.inputTokens}→{s.outputTokens}{' '}
                    токенів
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card title="Черга">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 text-sm">
            {Object.entries(data.queue).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1.5">
                <Badge tone={status === 'dead' ? 'red' : status === 'done' ? 'green' : 'neutral'}>
                  {status}
                </Badge>
                <strong>{count}</strong>
              </span>
            ))}
            {Object.keys(data.queue).length === 0 && (
              <span className="text-slate-500">Черга порожня.</span>
            )}
          </div>

          {data.deadJobs.length > 0 && (
            <div className="space-y-1.5">
              {data.deadJobs.map((job) => (
                <div key={job.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <Ban className="size-3.5 text-red-500" />
                  <code className="rounded bg-slate-100 px-1.5 py-0.5">{job.type}</code>
                  <span className="min-w-0 flex-1 truncate text-red-600">{job.lastError}</span>
                  <Button
                    variant="secondary"
                    onClick={() => void api.retryJob(job.id).then(() => void reload())}
                  >
                    <RotateCcw className="size-3.5" />
                    Ще раз
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'green' | 'amber' | 'red';
}) {
  const color = tone === 'green' ? 'text-emerald-600' : tone === 'amber' ? 'text-amber-600' : 'text-red-600';
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-600">{label}</span>
      <strong className={value === 0 && tone !== 'green' ? 'text-slate-400' : color}>{value}</strong>
    </div>
  );
}

function formatSlot(iso: string | null, timezone: string): React.ReactNode {
  if (!iso) return <span className="text-slate-400">—</span>;
  return (
    <span className="flex items-center gap-1.5">
      <Clock className="size-3.5 text-slate-400" />
      {formatDateTime(iso, { timezone, withZone: zoneDiffers(timezone) })}
    </span>
  );
}

export { AlertTriangle };
