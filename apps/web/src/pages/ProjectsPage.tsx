import type { ProjectDto } from '@tcf/shared';
import { AlertCircle, Clock, Loader2, Plus, Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Badge } from '../components/ui';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Помилка'));
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <AlertCircle className="size-4" />
        {error}
      </div>
    );
  }

  if (!projects) {
    return (
      <div className="flex justify-center py-20 text-slate-400">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Проєкти</h1>
          <p className="mt-1 text-sm text-slate-500">
            {projects.length === 0
              ? 'Кожен проєкт — окремий канал зі своїм контентом'
              : `${projects.length} ${plural(projects.length, 'канал', 'канали', 'каналів')}`}
          </p>
        </div>
        <Link
          to="/projects/new"
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          <Plus className="size-4" />
          Новий проєкт
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-8 py-16 text-center">
          <Radio className="mx-auto size-8 text-slate-300" />
          <h2 className="mt-4 font-medium">Проєктів ще немає</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            Створіть перший: вкажіть канал, токен бота й розклад — далі система сама планує теми,
            генерує пости й публікує їх.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {projects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectDto }) {
  const tone = project.status === 'active' ? 'green' : project.status === 'paused' ? 'amber' : 'neutral';
  const label =
    project.status === 'active' ? 'Активний' : project.status === 'paused' ? 'На паузі' : 'В архіві';

  return (
    <Link
      to={`/projects/${project.id}`}
      className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4 transition hover:border-slate-300 hover:shadow-sm"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{project.name}</span>
          <Badge tone={tone}>{label}</Badge>
          {!project.botTokenMask && <Badge tone="red">Без токена</Badge>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>{project.telegramChannelId}</span>
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {describeSchedule(project)}
          </span>
          <span>{project.timezone}</span>
          <span>
            {project.postsBuffer === 0 ? 'буфер вимкнено (JIT)' : `буфер ${project.postsBuffer}`}
          </span>
        </div>
      </div>
    </Link>
  );
}

function describeSchedule(project: ProjectDto): string {
  const s = project.schedule;
  if (s.mode === 'interval') return `кожні ${s.intervalMinutes} хв`;
  const days = s.weekdays.length === 0 ? 'щодня' : `${s.weekdays.length} дн/тиж`;
  return `${s.slots.join(', ')} · ${days}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
