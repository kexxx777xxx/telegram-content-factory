import type { Schedule } from '@tcf/shared';
import { Plus, X } from 'lucide-react';
import { Field, Input, Select } from './ui';

const WEEKDAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 7, label: 'Нд' },
];

/**
 * Times are wall-clock in the project's own timezone, not the browser's — the
 * hint says so, because that is the single most confusing thing about this form.
 */
export function ScheduleEditor({
  value,
  timezone,
  onChange,
}: {
  value: Schedule;
  timezone: string;
  onChange: (next: Schedule) => void;
}) {
  function switchMode(mode: Schedule['mode']) {
    if (mode === value.mode) return;
    onChange(
      mode === 'slots'
        ? { mode: 'slots', slots: ['09:00'], weekdays: [] }
        : { mode: 'interval', intervalMinutes: 240, anchor: '09:00' },
    );
  }

  return (
    <div className="space-y-4">
      <Field label="Режим розкладу">
        <Select value={value.mode} onChange={(e) => switchMode(e.target.value as Schedule['mode'])}>
          <option value="slots">Фіксовані слоти</option>
          <option value="interval">За інтервалом</option>
        </Select>
      </Field>

      {value.mode === 'slots' ? (
        <>
          <Field label="Час публікацій" hint={`Час у поясі проєкту (${timezone}), не у вашому.`}>
            <div className="flex flex-wrap gap-2">
              {value.slots.map((slot, index) => (
                <div key={index} className="flex items-center gap-1">
                  <Input
                    type="time"
                    value={slot}
                    className="w-28"
                    onChange={(e) => {
                      const slots = [...value.slots];
                      slots[index] = e.target.value;
                      onChange({ ...value, slots });
                    }}
                  />
                  {value.slots.length > 1 && (
                    <button
                      type="button"
                      aria-label="Прибрати слот"
                      onClick={() =>
                        onChange({ ...value, slots: value.slots.filter((_, i) => i !== index) })
                      }
                      className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    >
                      <X className="size-4" />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => onChange({ ...value, slots: [...value.slots, '12:00'] })}
                className="inline-flex items-center gap-1 rounded-lg border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                <Plus className="size-4" />
                Слот
              </button>
            </div>
          </Field>

          <Field label="Дні тижня" hint="Нічого не обрано — публікуємо щодня.">
            <div className="flex gap-1.5">
              {WEEKDAYS.map((day) => {
                const active = value.weekdays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() =>
                      onChange({
                        ...value,
                        weekdays: active
                          ? value.weekdays.filter((d) => d !== day.value)
                          : [...value.weekdays, day.value].sort((a, b) => a - b),
                      })
                    }
                    className={`w-11 rounded-lg border px-2 py-1.5 text-sm transition ${
                      active
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </Field>
        </>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Інтервал, хвилин" hint="Мінімум 15.">
            <Input
              type="number"
              min={15}
              value={value.intervalMinutes}
              onChange={(e) =>
                onChange({ ...value, intervalMinutes: Number(e.target.value) || 15 })
              }
            />
          </Field>
          <Field label="Початок відліку" hint={`Час у поясі проєкту (${timezone}).`}>
            <Input
              type="time"
              value={value.anchor}
              onChange={(e) => onChange({ ...value, anchor: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
