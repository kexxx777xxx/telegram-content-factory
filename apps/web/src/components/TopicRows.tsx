import type { ProjectDto, ReplenishReportDto, TopicsPage } from '@tcf/shared';
import { Check, Loader2, Sparkles, Trash2, Upload, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { LaunchButton } from './LaunchButton';
import { Badge, Button, Field, Notice, Textarea } from './ui';

/**
 * Topics rendered as rows of the posts list.
 *
 * A topic *is* a post with nothing but its subject yet — that is why a separate
 * "bank" read as a duplicate of the list next to it. The one real difference is
 * that a slot has a date and a topic does not, so the row says «без слоту»
 * where a post shows its time.
 */
export function TopicRows({
  project,
  query,
  onChanged,
}: {
  project: ProjectDto;
  query: string;
  onChanged: () => void;
}) {
  const [page, setPage] = useState<TopicsPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReplenishReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Topic id currently being promoted, so only its own buttons spin. */
  const [launching, setLaunching] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setPage(await api.listTopics(project.id));
    setSelected(new Set());
  }, [project.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (page?.topics ?? [])
      .filter((topic) => topic.status === 'new')
      .filter((topic) => !needle || topic.title.toLowerCase().includes(needle));
  }, [page, query]);

  async function replenish() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.replenishTopics(project.id, 20));
      await reload();
      onChanged();
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
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося імпортувати');
    } finally {
      setBusy(false);
    }
  }

  /**
   * A topic is a post without a slot, so the row offers the same two things the
   * list offers a post: put it in the buffer, or send it now.
   */
  async function launch(topicId: string, publish: boolean) {
    setLaunching(topicId);
    setError(null);
    try {
      await api.launchTopic(topicId, publish);
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося запустити тему');
    } finally {
      setLaunching(null);
    }
  }

  async function removeSelected() {
    setBusy(true);
    try {
      await api.deleteTopics([...selected]);
      await reload();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const counts = page?.counts;
  const bankOff = project.topicsBufferMin === 0;
  const low = counts && !bankOff && counts.fresh < project.topicsBufferMin;

  return (
    <div className="space-y-3">
      {visible.length > 0 && (
        <div className="space-y-2">
          {visible.map((topic) => (
            <div
              key={topic.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-slate-200 px-4 py-3 hover:bg-slate-50"
            >
              {/* Only the checkbox and title toggle selection — the buttons
                  beside them must not, which is why this is no longer one
                  <label> around the whole row. */}
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(topic.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(topic.id);
                    else next.delete(topic.id);
                    setSelected(next);
                  }}
                  className="size-4 shrink-0 rounded border-slate-300"
                />
                <Badge>без слоту</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{topic.title}</span>
              </label>

              <span className="text-xs text-slate-400">
                {topic.source === 'ai' ? 'AI' : 'вручну'}
                {topic.category ? ` · ${topic.category}` : ''}
              </span>

              <span className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => void launch(topic.id, false)}
                  disabled={busy || launching !== null}
                >
                  {launching === topic.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Wand2 className="size-4" />
                  )}
                  Згенерувати
                </Button>
                <LaunchButton
                  label="Опублікувати зараз"
                  confirm={`Згенерувати пост за темою «${topic.title}» і одразу опублікувати?`}
                  disabled={busy || launching !== null}
                  run={() => api.launchTopic(topic.id, true)}
                  onDone={() => {
                    void reload();
                    onChanged();
                  }}
                />
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
        <span>
          {bankOff
            ? 'Банк вимкнено: тему запитують у моделі перед кожним постом.'
            : counts
              ? `Без слоту: ${counts.fresh}. Коли їх стає менше ${project.topicsBufferMin}, банк автоматично поповнюється до ${project.topicsBufferMin} (мінімум 10 тем за раз).`
              : ''}
        </span>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <Button variant="danger" onClick={() => void removeSelected()} disabled={busy}>
              <Trash2 className="size-4" />
              Видалити ({selected.size})
            </Button>
          )}
          <Button variant="secondary" onClick={() => void replenish()} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Додати теми через AI
          </Button>
          <Button variant="secondary" onClick={() => setImporting(!importing)} disabled={busy}>
            <Upload className="size-4" />
            Імпорт списком
          </Button>
        </span>
      </div>

      {low && (
        <Notice>
          Тем без слоту менше за поріг ({project.topicsBufferMin}). Планувальник поповнить банк сам,
          але можна зробити це зараз.
        </Notice>
      )}

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
    </div>
  );
}
