import { forwardRef, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface ComboOption {
  value: string;
  label: string;
  /** Secondary text shown under the label and also searched. */
  description?: string;
  /** Options with the same group are listed under one header; pass them already grouped. */
  group?: string;
}

interface ComboboxProps {
  id: string;
  /** Text shown in the input (the chosen label or what the user typed). */
  value: string;
  /** Typing reports the text and the option whose label matches it exactly (or null); picking reports the option. */
  onChange: (text: string, option: ComboOption | null) => void;
  options: ComboOption[];
  placeholder?: string;
  /** Lets the user keep a value that is not in the list. */
  allowCustom?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  emptyText?: string;
  onBlur?: () => void;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Text input with a filtered, keyboard-navigable list (WAI-ARIA combobox pattern). */
export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(function Combobox(
  { id, value, onChange, options, placeholder, allowCustom, disabled, invalid, describedBy, emptyText = 'Sin resultados', onBlur },
  ref
) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Only filter once the user types; reopening a filled field shows the whole list.
  const [filtering, setFiltering] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const exact = useMemo(() => options.find((o) => fold(o.label) === fold(value)) ?? null, [options, value]);
  const visible = useMemo(() => {
    const q = fold(value);
    if (!filtering || !q) return options;
    return options.filter((o) => fold(`${o.label} ${o.description ?? ''} ${o.group ?? ''}`).includes(q));
  }, [options, value, filtering]);
  const showCustom = Boolean(allowCustom && value.trim() && !exact && filtering);
  const total = visible.length + (showCustom ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const selected = exact ? visible.indexOf(exact) : -1;
    setActive(selected >= 0 ? selected : 0);
  }, [open, visible, exact]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (option: ComboOption | null) => {
    if (option) onChange(option.label, option);
    else onChange(value.trim(), null);
    setOpen(false);
    setFiltering(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (total === 0) return;
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % total : (i - 1 + total) % total));
    } else if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      if (active < visible.length) pick(visible[active]);
      else if (showCustom) pick(null);
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation();
        setOpen(false);
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  let lastGroup: string | undefined;

  return (
    <div className="relative">
      <input
        ref={ref}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && total > 0 ? optionId(active) : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const text = e.target.value;
          setFiltering(true);
          setOpen(true);
          onChange(text, options.find((o) => fold(o.label) === fold(text)) ?? null);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setFiltering(false);
          onBlur?.();
        }}
        onKeyDown={onKeyDown}
        className={`w-full pl-3 pr-8 py-2 bg-[#0B1120] border rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed ${
          invalid ? 'border-rose-500/70 focus:border-rose-400' : 'border-slate-800 focus:border-sky-500'
        }`}
      />
      <ChevronDown className="w-3.5 h-3.5 text-slate-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />

      {open && !disabled && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-[#0B1120] border border-slate-700 rounded-lg shadow-xl py-1"
        >
          {visible.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            const selected = exact?.value === o.value;
            return (
              <li key={o.value} role="presentation">
                {header && (
                  <div role="presentation" className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {header}
                  </div>
                )}
                <div
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer ${i === active ? 'bg-sky-600/20' : ''}`}
                >
                  <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-sky-400 ${selected ? '' : 'invisible'}`} aria-hidden />
                  <div className="min-w-0">
                    <div className="text-slate-100">{o.label}</div>
                    {o.description && <div className="text-[11px] text-slate-400 truncate">{o.description}</div>}
                  </div>
                </div>
              </li>
            );
          })}
          {showCustom && (
            <li role="presentation">
              <div
                id={optionId(visible.length)}
                data-index={visible.length}
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(null)}
                onMouseEnter={() => setActive(visible.length)}
                className={`px-3 py-1.5 cursor-pointer border-t border-slate-800 text-sky-300 ${active === visible.length ? 'bg-sky-600/20' : ''}`}
              >
                Usar «{value.trim()}»
              </div>
            </li>
          )}
          {total === 0 && <li className="px-3 py-2 text-slate-500">{emptyText}</li>}
        </ul>
      )}
    </div>
  );
});
