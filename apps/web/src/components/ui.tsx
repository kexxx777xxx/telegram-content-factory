import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { InputHTMLAttributes } from 'react';

/** Small shared primitives so forms stay declarative and visually consistent. */

const inputBase =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-slate-900 disabled:bg-slate-50 disabled:text-slate-400';

export function Card({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      {title && <h2 className="font-medium">{title}</h2>}
      {hint && <p className="mt-1 text-sm text-slate-500">{hint}</p>}
      <div className={title ? 'mt-5' : ''}>{children}</div>
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
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && !error && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}
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
