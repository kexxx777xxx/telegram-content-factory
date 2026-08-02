import { KeyRound, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api/client';

export function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося увійти');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <form
        onSubmit={(e) => void submit(e)}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm"
      >
        <KeyRound className="size-6 text-slate-400" />
        <h1 className="mt-4 text-lg font-semibold">Вхід в адмінку</h1>
        <p className="mt-1 text-sm text-slate-500">Telegram Content Factory</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          autoComplete="current-password"
          placeholder="Пароль"
          className="mt-6 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-900"
        />

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-40"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Увійти
        </button>
      </form>
    </div>
  );
}
