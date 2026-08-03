import { AlertTriangle, Database, LayoutGrid, Loader2, LogOut, Radio, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import type { Health } from '@tcf/shared';
import { api, ApiError, type SessionState } from './api/client';
import { LoginScreen } from './pages/LoginScreen';
import { ProjectPage } from './pages/ProjectPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [nextSession, nextHealth] = await Promise.all([
      api.session(),
      api.health().catch(() => null),
    ]);
    setSession(nextSession);
    setHealth(nextHealth);
  }, []);

  useEffect(() => {
    refresh()
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setSession({ authenticated: false, authEnabled: true });
        }
      })
      .finally(() => setLoading(false));
  }, [refresh]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }

  if (session && !session.authenticated) {
    return <LoginScreen onSuccess={() => void refresh()} />;
  }

  return (
    <BrowserRouter>
      <div className="flex min-h-full flex-col">
        {session && !session.authEnabled && <AuthDisabledBanner />}

        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-4">
            <Link to="/" className="flex items-center gap-3">
              <Radio className="size-5 text-slate-500" />
              <span className="font-semibold">Telegram Content Factory</span>
            </Link>
            <div className="ml-auto flex items-center gap-4 text-sm text-slate-500">
              <Link to="/projects" className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-slate-100">
                <LayoutGrid className="size-4" />
                Проєкти
              </Link>
              <Link to="/settings" className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-slate-100">
                <SlidersHorizontal className="size-4" />
                Налаштування
              </Link>
              <DatabaseBadge health={health} />
              {session?.authEnabled && (
                <button
                  type="button"
                  onClick={() => void api.logout().then(() => void refresh())}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-slate-100"
                >
                  <LogOut className="size-4" />
                  Вийти
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function AuthDisabledBanner() {
  return (
    <div className="flex items-center justify-center gap-2 bg-red-600 px-4 py-2 text-sm font-medium text-white">
      <AlertTriangle className="size-4 shrink-0" />
      Авторизація вимкнена (ADMIN_AUTH_ENABLED=false). Адмінка відкриває бот-токени та API-ключі
      кожному, хто має доступ до порту.
    </div>
  );
}

/**
 * Icon only. A healthy database is the expected state and does not deserve a
 * permanent sentence in the header; the label lives in the tooltip, and the
 * colour is what carries the signal when it stops being healthy.
 */
function DatabaseBadge({ health }: { health: Health | null }) {
  const up = health?.database === 'up';
  const label = up ? 'База підключена' : 'База недоступна';
  return (
    <span
      title={label}
      aria-label={label}
      className={up ? 'text-slate-400' : 'text-red-600'}
    >
      <Database className="size-4" />
    </span>
  );
}
