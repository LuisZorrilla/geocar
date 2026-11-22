import { Ban, CheckCircle2, Clock, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { AUTH_STATE_LABELS, formatDateAr, type DriverAuthState } from '../shared/drivers.ts';

const STYLE: Record<DriverAuthState, { cls: string; Icon: typeof CheckCircle2 }> = {
  habilitado: { cls: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300', Icon: CheckCircle2 },
  por_vencer: { cls: 'bg-amber-500/10 border-amber-500/30 text-amber-300', Icon: Clock },
  pendiente: { cls: 'bg-sky-500/10 border-sky-500/30 text-sky-300', Icon: ShieldQuestion },
  no_autorizado: { cls: 'bg-rose-500/10 border-rose-500/30 text-rose-300', Icon: ShieldAlert },
  deshabilitado: { cls: 'bg-slate-700/40 border-slate-600 text-slate-300', Icon: Ban },
};

/** Authorization state: icon + text, never color alone. */
export function AuthBadge({ state, title }: { state: DriverAuthState; title?: string }) {
  const { cls, Icon } = STYLE[state];
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium whitespace-nowrap ${cls}`}>
      <Icon className="w-3 h-3" aria-hidden />
      {AUTH_STATE_LABELS[state]}
    </span>
  );
}

/** «vence en 12 días» / «vencido hace 3 días» with the date. */
export function ExpiryText({ date, days }: { date?: string; days?: number }) {
  if (!date || days === undefined) return <span className="text-slate-500">—</span>;
  const tone = days < 0 ? 'text-rose-300' : days <= 30 ? 'text-amber-300' : 'text-slate-300';
  const rel = days < 0 ? `vencido hace ${-days} ${-days === 1 ? 'día' : 'días'}` : days === 0 ? 'vence hoy' : `vence en ${days} ${days === 1 ? 'día' : 'días'}`;
  return (
    <span className="leading-tight">
      <span className="text-slate-200">{formatDateAr(date)}</span>
      <span className={`block text-[11px] ${tone}`}>{rel}</span>
    </span>
  );
}
