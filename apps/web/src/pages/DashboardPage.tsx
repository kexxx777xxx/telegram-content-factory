import { AlertTriangle, Clock, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type DashboardData } from '../api/client';
import { QueueCard } from '../components/QueueCard';
import { formatDateTime, formatLocalTime } from '../lib/time';
import { Badge, Card, Notice } from '../components/ui';

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
        hint="«Буфер» — скільки постів уже готові наперед. Поки це число більше за нуль, найближчий слот вийде навіть якщо моделі зараз недоступні; нуль означає, що пост робитиметься в останню мить. Час у таблиці — у поясі кожного проєкту."
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
        <Card title="SLO за 7 днів" hint="«Вчасно / із запізненням» звідси зникло разом із хвилиною, приписаною посту: спізнитись більше нема повз що.">
          <div className="space-y-2 text-sm">
            <Row label="Опубліковано" value={data.slo.published} tone="green" />
            <Row label="Зламалось" value={data.slo.failed} tone={data.slo.failed > 0 ? 'red' : 'green'} />
            <Row
              label="Резервних схем"
              value={`${data.slo.fallbackImages} з ${data.slo.totalImages}`}
              tone={data.slo.fallbackImages > 0 ? 'amber' : 'green'}
            />
          </div>
        </Card>

        <Card
          title="Витрати по ключах"
          hint="За сьогодні. Лічильники скидаються опівночі за UTC — це груба межа для бюджету, а не білінговий період провайдера."
        >
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

      {/*
        The same queue as in settings, not a summary of it.
        A count of dead jobs with no way to see which they are, or to do
        anything about them, is a notification — and the place people look first
        is the dashboard.
      */}
      <QueueCard />

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
      {formatDateTime(iso, { timezone })}
    </span>
  );
}

export { AlertTriangle };
