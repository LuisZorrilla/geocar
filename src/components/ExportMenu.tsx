import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Download, FileDown, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { downloadWithAuth } from '../lib/api.ts';

export type ExportFormat = 'pdf' | 'xlsx' | 'csv';

const FORMATS: Record<ExportFormat, { label: string; help: string; Icon: typeof FileText; tone: string }> = {
  pdf: { label: 'PDF', help: 'Para leer, imprimir o enviar', Icon: FileText, tone: 'text-rose-300' },
  xlsx: { label: 'Excel (.xlsx)', help: 'Para filtrar, ordenar y calcular', Icon: FileSpreadsheet, tone: 'text-emerald-300' },
  csv: { label: 'CSV', help: 'Datos planos para otros sistemas', Icon: FileDown, tone: 'text-sky-300' },
};

interface Props {
  /** Export endpoint without `format` (e.g. /api/reports/export). */
  url: string;
  /** Extra query parameters, usually the screen's active filters (empty values are skipped). */
  params?: Record<string, string | undefined>;
  label?: string;
  /** Records that will be exported, shown as a hint under the options. */
  count?: number;
  /** Shows "con los filtros actuales" in the hint. */
  filtered?: boolean;
  formats?: ExportFormat[];
  /** Base name used only if the server doesn't send one. */
  fileName?: string;
  align?: 'left' | 'right';
  size?: 'sm' | 'xs';
}

/**
 * «Exportar ▾» button with PDF, Excel and CSV. Keyboard: Enter/Space/↓ open, ↑/↓ move, Esc closes
 * and returns focus to the button. Errors are shown inside the menu instead of a browser alert.
 */
export function ExportMenu({
  url,
  params,
  label = 'Exportar',
  count,
  filtered,
  formats = ['pdf', 'xlsx', 'csv'],
  fileName = 'reporte',
  align = 'right',
  size = 'sm',
}: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<ExportFormat | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    requestAnimationFrame(() => itemsRef.current[0]?.focus());
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setError('');
    setDone(null);
    const query = new URLSearchParams({ format });
    for (const [k, v] of Object.entries(params ?? {})) if (v) query.set(k, v);
    try {
      await downloadWithAuth(`${url}?${query}`, `${fileName}.${format}`);
      setDone(format);
      setTimeout(() => {
        setOpen(false);
        setDone(null);
      }, 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo generar el archivo.');
    } finally {
      setBusy(null);
    }
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = itemsRef.current.filter(Boolean) as HTMLButtonElement[];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const pad = size === 'xs' ? 'px-2.5 py-1' : 'px-3 py-1.5';
  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={`inline-flex items-center gap-1.5 ${pad} rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 cursor-pointer whitespace-nowrap`}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" aria-hidden /> : <Download className="w-3.5 h-3.5 text-sky-400" aria-hidden />}
        {label}
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`${label}: elegir formato`}
          onKeyDown={onMenuKey}
          className={`absolute z-50 mt-1.5 w-64 rounded-xl border border-slate-700 bg-[#0F172A] shadow-xl shadow-black/40 p-1.5 ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {formats.map((f, idx) => {
            const meta = FORMATS[f];
            const isBusy = busy === f;
            return (
              <button
                key={f}
                ref={(el) => {
                  itemsRef.current[idx] = el;
                }}
                type="button"
                role="menuitem"
                disabled={busy !== null}
                onClick={() => run(f)}
                className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-slate-800 focus:bg-slate-800 focus:outline-none disabled:opacity-60 disabled:cursor-wait cursor-pointer"
              >
                {isBusy ? (
                  <Loader2 className="w-4 h-4 mt-0.5 shrink-0 text-sky-300 animate-spin" aria-hidden />
                ) : (
                  <meta.Icon className={`w-4 h-4 mt-0.5 shrink-0 ${meta.tone}`} aria-hidden />
                )}
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-slate-100">
                    {isBusy ? `Generando ${meta.label}…` : done === f ? `${meta.label} descargado` : meta.label}
                  </span>
                  <span className="block text-[11px] text-slate-400">{meta.help}</span>
                </span>
              </button>
            );
          })}
          {(count !== undefined || error) && (
            <div className="mt-1 border-t border-slate-800 px-2.5 pt-2 pb-1 space-y-1" aria-live="polite">
              {count !== undefined && (
                <p className="text-[11px] text-slate-400">
                  Se exportan {count.toLocaleString('es-AR')} {count === 1 ? 'registro' : 'registros'}
                  {filtered ? ' con los filtros actuales' : ''}.
                </p>
              )}
              {error && <p className="text-[11px] text-rose-300">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
