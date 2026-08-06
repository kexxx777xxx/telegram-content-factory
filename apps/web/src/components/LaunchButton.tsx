import { Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import type { LaunchResult } from '../api/client';
import { Button } from './ui';

/**
 * The manual launch, used by both the post rows and the topic rows.
 *
 * It lives in its own file rather than beside either of them: a topic is a post
 * without a slot, so both lists need it, and keeping it in `PostsCard` made the
 * two import each other in a cycle.
 *
 * Confirmation is not ceremony: this writes to a live channel, and unlike
 * everything else on the card it cannot be undone.
 */
export function LaunchButton({
  label,
  confirm,
  disabled,
  run,
  onDone,
}: {
  label: string;
  confirm: string;
  disabled?: boolean;
  run: () => Promise<LaunchResult>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function click() {
    if (!window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const launched = await run();
      setResult(
        launched.job === 'publish_post'
          ? 'У черзі на публікацію'
          : launched.job === 'generate_post'
            ? 'Генерується у буфер, у канал не піде'
            : 'Генерується і одразу піде в канал',
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося запустити');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => void click()} disabled={busy || disabled}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {label}
      </Button>
      {result && <span className="text-sm text-emerald-600">{result}</span>}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </>
  );
}
