import { AlertTriangle, Database, LayoutDashboard, Loader2, LogOut, Radio } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Health } from '@tcf/shared';
import { api, ApiError, type SessionState } from './api/client';
import { LoginScreen } from './pages/LoginScreen';

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
        if (err instanceof ApiError && err.status === 401) setSession({ authenticated: false, authEnabled: true });
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
    <div className="flex min-h-full flex-col">
      {session && !session.authEnabled && <AuthDisabledBanner />}

      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
          <Radio className="size-5 text-slate-500" />
          <h1 className="font-semibold">Telegram Content Factory</h1>
          <div className="ml-auto flex items-center gap-4 text-sm text-slate-500">
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

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <EmptyState />
      </main>
    </div>
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

function DatabaseBadge({ health }: { health: Health | null }) {
  const up = health?.database === 'up';
  return (
    <span className={`flex items-center gap-1.5 ${up ? 'text-slate-500' : 'text-red-600'}`}>
      <Database className="size-4" />
      {up ? 'База підключена' : 'База недоступна'}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-8 py-16 text-center">
      <LayoutDashboard className="mx-auto size-8 text-slate-300" />
      <h2 className="mt-4 text-lg font-medium">Проєктів ще немає</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
        Скелет піднято: база, конфіг і авторизація працюють. Керування проєктами зʼявиться на
        наступному кроці.
      </p>
    </div>
  );
}
