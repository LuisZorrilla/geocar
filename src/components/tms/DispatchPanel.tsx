import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Vehicle } from '../../shared/types.ts';
import { TRIP_STATUS_LABELS, type TripStatus } from '../../shared/tms.ts';
import { apiRequest } from '../../lib/api.ts';
import { TripDetail } from './TripsPanel.tsx';
import { Field, errMsg, fmtDateTime, inputCls } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;

interface Board {
  from: string;
  to: string;
  now: string;
  rows: Array<{
    vehicleId: string;
    unitCode: string;
    plate: string;
    trips: Array<{
      id: string;
      status: TripStatus;
      driverName: string;
      startAt: string;
      endAt: string;
      estimatedEnd: boolean;
      late: boolean;
      stops: Array<{ seq: number; kind: string; placeName: string; status: string; at: string | null; estimated: boolean; late: boolean }>;
    }>;
  }>;
  idle: Array<{ vehicleId: string; unitCode: string; plate: string }>;
}

const BAR: Record<TripStatus, string> = {
  planificado: 'bg-indigo-500/30 border-indigo-400/60',
  en_curso: 'bg-amber-500/30 border-amber-400/70',
  finalizado: 'bg-emerald-500/25 border-emerald-400/50',
  cancelado: 'bg-slate-700/30 border-slate-600',
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Day timeline per unit: trips as bars, stops as marks (real or estimated), "now" line, delays. */
export function DispatchPanel({ vehicles, canWrite, notify }: { vehicles: Vehicle[]; canWrite: boolean; notify: Notify }) {
  const [day, setDay] = useState(todayIso());
  const [board, setBoard] = useState<Board | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const from = new Date(`${day}T00:00:00`);
    const to = new Date(from.getTime() + 86_400_000);
    try {
      setBoard(await apiRequest<Board>(`/api/routing/dispatch?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`));
    } catch (err) {
      notify(errMsg(err, 'No se pudo cargar el tablero.'), 'err');
    }
  }, [day, notify]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Visible hours: the trips' span (padded), at least 06–20.
  const range = useMemo(() => {
    if (!board) return null;
    const dayStart = Date.parse(board.from);
    const times = board.rows.flatMap((r) => r.trips.flatMap((t) => [Date.parse(t.startAt), Date.parse(t.endAt)]));
    const h = (ms: number) => (ms - dayStart) / 3_600_000;
    const lo = Math.max(0, Math.floor(Math.min(6, ...times.map(h)) - 0.5));
    const hi = Math.min(24, Math.ceil(Math.max(20, ...times.map(h)) + 0.5));
    return { dayStart, lo, hi, span: hi - lo };
  }, [board]);
  const pos = (iso: string) => (range ? Math.max(0, Math.min(100, (((Date.parse(iso) - range.dayStart) / 3_600_000 - range.lo) / range.span) * 100)) : 0);
  const nowPct = board && range ? pos(board.now) : null;
  const showNow = nowPct !== null && board && Date.parse(board.now) >= Date.parse(board.from) && Date.parse(board.now) < Date.parse(board.to);

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="dp-day" label="Día">
          <input id="dp-day" type="date" className={`${inputCls} font-mono`} value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-3 pb-2 text-slate-400">
          {(['planificado', 'en_curso', 'finalizado'] as TripStatus[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5"><span className={`inline-block w-4 h-2.5 rounded-sm border ${BAR[s]}`} aria-hidden />{TRIP_STATUS_LABELS[s]}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 h-2.5 rounded-sm border-2 border-rose-400" aria-hidden />Con demora</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full bg-slate-100" aria-hidden />Parada hecha</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full border border-slate-100" aria-hidden />Estimada</span>
        </div>
      </div>

      {board && range && (
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl overflow-x-auto">
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[150px_1fr] border-b border-slate-800 text-slate-500">
              <div className="px-3 py-2">Unidad</div>
              <div className="relative h-8">
                {Array.from({ length: range.span + 1 }, (_, i) => range.lo + i).map((hour) => (
                  <span key={hour} className="absolute top-2 -translate-x-1/2 font-mono" style={{ left: `${((hour - range.lo) / range.span) * 100}%` }}>{String(hour).padStart(2, '0')}</span>
                ))}
              </div>
            </div>
            {board.rows.map((r) => (
              <div key={r.vehicleId} className="grid grid-cols-[150px_1fr] border-b border-slate-800/60">
                <div className="px-3 py-2">
                  <div className="text-slate-100">{r.unitCode}</div>
                  <div className="text-slate-500">{r.plate}</div>
                </div>
                <div className="relative h-14">
                  {Array.from({ length: range.span + 1 }, (_, i) => (
                    <span key={i} className="absolute top-0 bottom-0 border-l border-slate-800/70" style={{ left: `${(i / range.span) * 100}%` }} aria-hidden />
                  ))}
                  {r.trips.map((t) => {
                    const left = pos(t.startAt);
                    const width = Math.max(1.5, pos(t.endAt) - left);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setOpenId(t.id)}
                        title={`${t.id} · ${t.driverName} · ${fmtDateTime(t.startAt)} a ${fmtDateTime(t.endAt)}${t.estimatedEnd ? ' (estimado)' : ''}`}
                        className={`absolute top-2 h-10 rounded-md border text-left px-1.5 overflow-hidden cursor-pointer hover:brightness-125 ${BAR[t.status]} ${t.late ? 'border-2 border-rose-400' : ''}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        aria-label={`Viaje ${t.id}, ${TRIP_STATUS_LABELS[t.status]}${t.late ? ', con demora' : ''}`}
                      >
                        <span className="block font-mono text-[10px] text-slate-100 truncate">{t.id}</span>
                        <span className="block text-[10px] text-slate-300 truncate">{t.driverName}</span>
                        {t.stops.filter((s) => s.at).map((s) => (
                          <span
                            key={s.seq}
                            title={`${s.seq}. ${s.kind === 'carga' ? 'Carga' : 'Descarga'} · ${s.placeName} · ${fmtDateTime(s.at!)}${s.estimated ? ' (estimada)' : ''}`}
                            className={`absolute bottom-0.5 w-2 h-2 -translate-x-1/2 rounded-full ${s.estimated ? 'border' : ''} ${s.late ? (s.estimated ? 'border-rose-300' : 'bg-rose-300') : s.estimated ? 'border-slate-100' : 'bg-slate-100'}`}
                            style={{ left: `${((pos(s.at!) - left) / width) * 100}%` }}
                            aria-hidden
                          />
                        ))}
                      </button>
                    );
                  })}
                  {showNow && <span className="absolute top-0 bottom-0 w-px bg-rose-400" style={{ left: `${nowPct}%` }} aria-hidden />}
                </div>
              </div>
            ))}
            {board.rows.length === 0 && <div className="p-8 text-center text-slate-400">No hay viajes ese día. Armalos en «Planificador» o «Viajes».</div>}
          </div>
        </div>
      )}

      {board && board.idle.length > 0 && (
        <div className="bg-[#11192C] border border-slate-800/80 rounded-xl p-3">
          <div className="font-medium text-slate-200 mb-1.5">Unidades sin viajes ese día ({board.idle.length})</div>
          <div className="flex flex-wrap gap-1.5">
            {board.idle.map((v) => <span key={v.vehicleId} className="px-2 py-0.5 rounded-md border border-slate-700 text-slate-300">{v.unitCode}</span>)}
          </div>
        </div>
      )}

      {openId && <TripDetail tripId={openId} vehicles={vehicles} canWrite={canWrite} notify={notify} onClose={() => setOpenId(null)} onChanged={() => void load()} />}
    </div>
  );
}
