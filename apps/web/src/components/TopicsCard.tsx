import type { ProjectDto, ReplenishReportDto, TopicsPage } from '@tcf/shared';
import { Check, Loader2, Sparkles, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Button, Card, Field, Notice, Textarea } from './ui';

export function TopicsCard({ project }: { project: ProjectDto }) {
  const [page, setPage] = useState<TopicsPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReplenishReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setPage(await api.listTopics(project.id));
    setSelected(new Set());
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function replenish() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.replenishTopics(project.id, 20));
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося поповнити банк');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importTopics(project.id, importText);
      setReport({ ...result, requested: 0, generated: 0, model: '—' });
      setImportText('');
      setImporting(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося імпортувати');
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected() {
    setBusy(true);
    try {
      await api.deleteTopics([...selected]);
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const counts = page?.counts;
  const bankOff = project.topicsBufferMin === 0;
  const low = counts && !bankOff && counts.fresh < project.topicsBufferMin;

  return (
    <Card
      title="Банк тем"
      hint={
        bankOff
          ? 'Банк вимкнено (мінімум = 0): тема запитуватиметься в моделі перед кожним постом.'
          : `Коли вільних тем стає менше ${project.topicsBufferMin}, банк поповнюється автоматично.`
      }
    >
      <div className="space-y-4">
        {counts && (
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <strong className={low ? 'text-amber-600' : ''}>{counts.fresh}</strong>
              <span className="text-slate-500">вільних</span>
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <strong>{counts.queued}</strong> в роботі
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <strong>{counts.used}</strong> використано
            </span>
            <span className="flex items-center gap-1.5 text-slate-500">
              <strong>{counts.total}</strong> усього
            </span>
          </div>
        )}

        {low && (
          <Notice>
            Вільних тем менше за поріг ({project.topicsBufferMin}). Планувальник поповнить банк сам,
            але можна зробити це зараз.
          </Notice>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => void replenish()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Поповнити через AI
          </Button>
          <Button variant="secondary" onClick={() => setImporting(!importing)} disabled={busy}>
            <Upload className="size-4" />
            Імпорт списком
          </Button>
          {selected.size > 0 && (
            <Button variant="danger" onClick={() => void removeSelected()} disabled={busy}>
              <Trash2 className="size-4" />
              Видалити ({selected.size})
            </Button>
          )}
        </div>

        {importing && (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <Field
              label="Список тем"
              hint="Одна тема на рядок. Необовʼязково «Категорія | Назва». Дублікати відсіються самі."
            >
              <Textarea
                rows={6}
                value={importText}
                placeholder={'Патерни | Circuit Breaker\nІдемпотентність у чергах'}
                onChange={(e) => setImportText(e.target.value)}
              />
            </Field>
            <Button onClick={() => void runImport()} disabled={busy || !importText.trim()}>
              Імпортувати
            </Button>
          </div>
        )}

        {error && <Notice tone="red">{error}</Notice>}

        {report && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <Check className="mr-1.5 inline size-4" />
            Додано {report.inserted}
            {report.duplicates > 0 && `, відсіяно дублікатів: ${report.duplicates}`}
            {report.model !== '—' && ` · ${report.model}`}
          </div>
        )}

        {page && page.topics.length > 0 && (
          <div className="max-h-96 overflow-auto rounded-lg border border-slate-200">
            {page.topics.map((topic) => (
              <label
                key={topic.id}
                className="flex cursor-pointer items-start gap-3 border-b border-slate-100 px-3 py-2 last:border-0 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={selected.has(topic.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(topic.id);
                    else next.delete(topic.id);
                    setSelected(next);
                  }}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{topic.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    {topic.category && <span>{topic.category}</span>}
                    <span>{topic.source === 'ai' ? 'AI' : 'вручну'}</span>
                    <code className="text-[10px]">{topic.normalizedHash.slice(0, 48)}</code>
                  </span>
                </span>
                {topic.status !== 'new' && (
                  <Badge tone={topic.status === 'used' ? 'green' : 'amber'}>
                    {topic.status === 'used' ? 'використана' : topic.status === 'queued' ? 'в роботі' : 'відхилена'}
                  </Badge>
                )}
              </label>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
