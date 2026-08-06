import type { ProjectDto, ReplenishReportDto } from '@tcf/shared';
import { Check, Loader2, Sparkles, Upload } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { Button, Field, Notice, Textarea } from './ui';

/**
 * The controls that fill the bank, under the one list they fill.
 *
 * This used to render the topics as rows of its own. It no longer does: an idea
 * is a post with `status: 'idea'`, so it appears in the list above like every
 * other row, with the same badge, the same actions and the same filter. What is
 * left here is only what applies to ideas *in bulk* — asking a model for more,
 * or pasting a list in.
 */
export function IdeaTools({
  project,
  onChanged,
}: {
  project: ProjectDto;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReplenishReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');

  async function replenish() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(await api.replenishIdeas(project.id, 20));
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
      const result = await api.importIdeas(project.id, importText);
      setReport({ ...result, requested: 0, generated: 0, model: '—' });
      setImportText('');
      setImporting(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося імпортувати');
    } finally {
      setBusy(false);
    }
  }

  const bankOff = project.topicsBufferMin === 0;

  return (
    <div className="space-y-3 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>
          {bankOff
            ? 'Банк вимкнено: тему запитують у моделі перед кожним постом.'
            : `Коли тем без слоту стає менше ${project.topicsBufferMin}, банк поповнюється автоматично до ${project.topicsBufferMin} (мінімум 10 за раз).`}
        </span>

        <span className="ml-auto flex flex-wrap items-center gap-2">
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
