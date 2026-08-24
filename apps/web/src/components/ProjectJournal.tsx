import type { LogEntry, ProjectDto } from '@tcf/shared';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDateTime } from '../lib/time';
import { api } from '../api/client';
import { Badge, Button, Card, Notice } from './ui';

const KIND_LABEL: Record<string, { text: string; tone: 'neutral' | 'green' | 'amber' | 'red' }> = {
  topic_created: { text: 'тема', tone: 'neutral' },
  topics_replenished: { text: 'банк тем', tone: 'neutral' },
  model_request: { text: 'запит', tone: 'neutral' },
  model_response: { text: 'відповідь', tone: 'green' },
  generation_step: { text: 'крок', tone: 'amber' },
  publish: { text: 'публікація', tone: 'green' },
  note: { text: 'примітка', tone: 'neutral' },
};

/**
 * The channel's timeline.
 *
 * Defaults to project-wide entries — topics, buffer refills, publications —
 * because per-post prompts belong to the post they came from, and mixing them
 * in turns a history into a wall. "Усе" is one click away when debugging.
 */
export function ProjectJournal({ project }: { project: ProjectDto }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [tariff, setTariff] = useState<'all' | 'batch' | 'sync'>('all');
  const [model, setModel] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      setEntries(await api.projectLog(project.id, scope));
    } finally {
      setBusy(false);
    }
  }, [project.id, scope]);

  useEffect(() => {
    if (project.logEnabled) void reload();
    else setEntries([]);
  }, [reload, project.logEnabled]);

  /*
   * Список моделей будується з того, що справді є в журналі, а не з каталогу
   * провайдера: фільтр, який пропонує двадцять моделей і дає нуль записів на
   * дев'ятнадцяти з них, — це не фільтр.
   */
  const models = useMemo(
    () => [...new Set((entries ?? []).map((e) => e.model).filter((m): m is string => !!m))].sort(),
    [entries],
  );

  const visible = useMemo(
    () =>
      (entries ?? []).filter((entry) => {
        if (model && entry.model !== model) return false;
        if (tariff === 'batch' && !entry.batch) return false;
        if (tariff === 'sync' && entry.batch) return false;
        return true;
      }),
    [entries, model, tariff],
  );

  return (
    <Card title="Журнал" hint="Що відбувалось у проєкті: теми, буфер, генерація, публікації.">
      <div className="space-y-3">
        {!project.logEnabled ? (
          <Notice>
            Журнал вимкнено. Увімкніть його вище й збережіть — записи почнуть зʼявлятися з
            наступної дії планувальника.
          </Notice>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {(['project', 'all'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setScope(value)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    scope === value
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {value === 'project' ? 'події проєкту' : 'усе, включно з промптами'}
                </button>
              ))}
              <Button variant="secondary" className="ml-auto" onClick={() => void reload()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                Оновити
              </Button>
            </div>

            {/* Два питання, які ставлять до журналу найчастіше: «що зробила ось
                ця модель» і «що з цього пішло за пів ціни». */}
            <div className="flex flex-wrap items-center gap-2">
              {(['all', 'batch', 'sync'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTariff(value)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    tariff === value
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {value === 'all' ? 'будь-який тариф' : value === 'batch' ? 'batch (−50%)' : 'звичайні виклики'}
                </button>
              ))}

              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600"
              >
                <option value="">усі моделі</option>
                {models.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {!entries ? (
              <div className="flex justify-center py-4 text-slate-400">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : entries.length === 0 ? (
              <p className="text-sm text-slate-500">Записів поки немає.</p>
            ) : visible.length === 0 ? (
              <p className="text-sm text-slate-500">Під фільтр не потрапив жоден запис.</p>
            ) : (
              <div className="max-h-96 space-y-1.5 overflow-auto">
                {visible.map((entry) => {
                  const kind = KIND_LABEL[entry.kind] ?? { text: entry.kind, tone: 'neutral' as const };
                  return (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-baseline gap-2 rounded-lg border border-slate-100 px-3 py-1.5 text-xs"
                    >
                      <span className="font-mono text-slate-400">
                        {formatDateTime(entry.createdAt, { timezone: project.timezone })}
                      </span>
                      <Badge tone={entry.ok ? kind.tone : 'red'}>{kind.text}</Badge>
                      {entry.source && (
                        <span className="text-slate-400">
                          {entry.source === 'manual' ? 'вручну' : 'авто'}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 text-slate-700">{entry.message}</span>
                      {entry.batch && <Badge tone="green">batch</Badge>}
                      {entry.model && <span className="font-mono text-slate-400">{entry.model}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
