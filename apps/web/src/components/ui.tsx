import { Info } from 'lucide-react';
import { useId, useState, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import type { InputHTMLAttributes } from 'react';

/** Small shared primitives so forms stay declarative and visually consistent. */

const inputBase =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 disabled:bg-slate-50 disabled:text-slate-400';

/**
 * An explanation parked behind an ⓘ next to whatever it explains.
 *
 * Every hint used to sit under its field as a permanent paragraph. Together
 * they took more vertical space than the controls did, and — read every day —
 * they stopped being read at all. Here the text is one hover (or one tap, or
 * one Tab) away and costs nothing until it is wanted.
 *
 * Hover *and* click, because hover does not exist on a touchscreen, and focus,
 * because a keyboard has to reach it too.
 */
export function InfoHint({ children, className = '' }: { children: ReactNode; className?: string }) {
  // Two reasons to be open, kept apart on purpose. With one flag a click on a
  // mouse arrived *after* the hover had already opened the panel, so pressing
  // the icon closed it — the one gesture everybody tries first did nothing.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const id = useId();

  return (
    <span className={`relative inline-flex align-middle ${className}`}>
      <button
        type="button"
        aria-label="Пояснення"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={(e) => {
          // Hints live inside <label>, where a click would otherwise land in the
          // field and steal focus from what the reader just opened.
          e.preventDefault();
          e.stopPropagation();
          setPinned(!pinned);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => {
          setHovered(false);
          setPinned(false);
        }}
        className="text-slate-400 transition hover:text-slate-700"
      >
        <Info className="size-3.5" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-full z-20 mt-1.5 w-72 max-w-[80vw] -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-normal leading-relaxed text-slate-600 shadow-lg"
        >
          {children}
        </span>
      )}
    </span>
  );
}

export function Card({
  title,
  hint,
  actions,
  children,
}: {
  title?: string;
  hint?: ReactNode;
  /** Controls that belong to the card as a whole; they sit on the title line. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      {(title || actions) && (
        <div className="flex flex-wrap items-center gap-2">
          {title && (
            <h2 className="flex items-center gap-1.5 font-medium">
              {title}
              {hint && <InfoHint>{hint}</InfoHint>}
            </h2>
          )}
          {actions && <span className="ml-auto flex items-center gap-2">{actions}</span>}
        </div>
      )}
      <div className={title || actions ? 'mt-5' : ''}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
        {label}
        {hint && <InfoHint>{hint}</InfoHint>}
      </span>
      <div className="mt-1.5">{children}</div>
      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputBase} ${props.className ?? ''}`} />;
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: InputHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
  children?: ReactNode;
}) {
  const styles = {
    primary: 'bg-slate-900 text-white hover:bg-slate-800',
    secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
    danger: 'bg-red-600 text-white hover:bg-red-700',
  }[variant];

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-40 ${styles} ${className}`}
    />
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'green' | 'amber' | 'red';
  children: ReactNode;
}) {
  const styles = {
    neutral: 'bg-slate-100 text-slate-600',
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${styles}`}>
      {children}
    </span>
  );
}

/**
 * Segmented control for short, mutually exclusive choices.
 *
 * Preferred over a `<select>` when the options are few and the current value
 * matters at a glance — a dropdown hides two thirds of the state behind a click.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string; tone?: 'green' | 'amber' | 'neutral' }[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const activeStyle = {
    green: 'bg-emerald-600 text-white',
    amber: 'bg-amber-500 text-white',
    neutral: 'bg-slate-900 text-white',
  };

  return (
    <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-40 ${
              active
                ? activeStyle[option.tone ?? 'neutral']
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Used wherever a setting is legal but has a consequence the operator should
 * know about before choosing it — buffers of 0, auth disabled, and so on.
 */
export function Notice({ tone = 'amber', children }: { tone?: 'amber' | 'red'; children: ReactNode }) {
  const styles = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    red: 'border-red-200 bg-red-50 text-red-900',
  }[tone];
  return <div className={`rounded-lg border px-3 py-2 text-xs ${styles}`}>{children}</div>;
}

/**
 * Tab strip for a page split into sections.
 *
 * A project has more settings than fit on one readable canvas, and scrolling
 * past the schedule to reach the posts is how an operator loses their place.
 */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; badge?: ReactNode }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
              active
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'
            }`}
          >
            {option.label}
            {option.badge}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Collapsed detail. Everything an operator needs *sometimes* goes in here, so
 * the row itself keeps only what they need every time.
 */
export function Spoiler({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group rounded-lg border border-slate-200 bg-slate-50" open={defaultOpen}>
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-slate-600 hover:text-slate-900">
        <span className="inline-block transition group-open:rotate-90">▸</span> {label}
      </summary>
      <div className="border-t border-slate-200 px-3 py-3">{children}</div>
    </details>
  );
}

/**
 * The name a field takes inside prompts. Without it, `{{persona}}` is knowledge
 * that lives only in the prompt editor, and the two drift apart.
 */
export function VarTag({ name }: { name: string }) {
  return (
    <code
      title="Підставляється в промпти під цією назвою"
      className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
    >
      {'{{'}
      {name}
      {'}}'}
    </code>
  );
}

/**
 * How a key is named everywhere it can be chosen.
 *
 * The label is what the operator typed, so it is what they recognise. A
 * position number in front of it («Ключ 2 · Paid») added a second name for the
 * same thing and made every dropdown read like a form field.
 */
export function keyName(key: { label: string; isDefault: boolean }): string {
  return `${key.label}${key.isDefault ? ' (зараз дефолтний)' : ''}`;
}
