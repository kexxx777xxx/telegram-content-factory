import type { LogEntry, ProjectDto } from '@tcf/shared';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
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

            {!entries ? (
              <div className="flex justify-center py-4 text-slate-400">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : entries.length === 0 ? (
              <p className="text-sm text-slate-500">Записів поки немає.</p>
            ) : (
              <div className="max-h-96 space-y-1.5 overflow-auto">
                {entries.map((entry) => {
                  const kind = KIND_LABEL[entry.kind] ?? { text: entry.kind, tone: 'neutral' as const };
                  return (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-baseline gap-2 rounded-lg border border-slate-100 px-3 py-1.5 text-xs"
                    >
                      <span className="font-mono text-slate-400">
                        {new Date(entry.createdAt).toLocaleString('uk-UA', {
                          timeZone: project.timezone,
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <Badge tone={entry.ok ? kind.tone : 'red'}>{kind.text}</Badge>
                      {entry.source && (
                        <span className="text-slate-400">
                          {entry.source === 'manual' ? 'вручну' : 'авто'}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 text-slate-700">{entry.message}</span>
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
