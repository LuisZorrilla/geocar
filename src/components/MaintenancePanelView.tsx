import { useMemo, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CalendarClock, Package, Table2, BarChart3 } from 'lucide-react';
import type { PartInventoryItem, WorkOrder } from '../shared/types.ts';
import { localToday, scheduledVsOverdueByAssetType, topConsumedParts } from '../lib/maintenancePanel.ts';
import { useMoney } from '../lib/money.tsx';

/**
 * Dark-mode steps of the reference data-viz palette, validated against the card surface
 * #11192C (validate_palette.js --mode dark): all checks pass, incl. the donut's wrap-around pair.
 */
const SURFACE = '#11192C';
const SERIES = {
  programado: '#3987e5', // categorical slot 1 (blue)
  vencido: '#d03b3b', // status «critical»: always paired with its label and icon
};
const PART_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']; // categorical slots 1-5, fixed order
const INK = { primary: '#E2E8F0', secondary: '#94A3B8', muted: '#64748B' };
const GRID = '#1E293B';
const AXIS = '#334155';

const pct = (share: number) => `${(share * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
const qty = (n: number) => n.toLocaleString('es-MX', { maximumFractionDigits: 2 });

interface MaintenancePanelViewProps {
  workOrders: WorkOrder[];
  partsInventory: PartInventoryItem[];
}

function Card({
  title,
  subtitle,
  icon,
  summary,
  tableView,
  onToggleTable,
  children,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  summary: ReactNode;
  tableView: boolean;
  onToggleTable: () => void;
  children: ReactNode;
}) {
  return (
    <section className="bg-[#11192C] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[#0B1120] border border-slate-800 flex items-center justify-center shrink-0">{icon}</div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
            <p className="text-xs text-slate-400">{subtitle}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggleTable}
          aria-pressed={tableView}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs text-slate-300 bg-[#0B1120] hover:bg-slate-800 border border-slate-800 cursor-pointer whitespace-nowrap shrink-0"
        >
          {tableView ? <BarChart3 className="w-3.5 h-3.5" /> : <Table2 className="w-3.5 h-3.5" />}
          {tableView ? 'Ver gráfico' : 'Ver tabla'}
        </button>
      </div>
      <div className="text-xs text-slate-300">{summary}</div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="h-64 flex items-center justify-center text-center text-xs text-slate-400 border border-dashed border-slate-800 rounded-lg px-6">
      {children}
    </div>
  );
}

function TooltipBox({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[#0B1120] border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 shadow-lg space-y-1">{children}</div>
  );
}

function Swatch({ color }: { color: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: color }} aria-hidden />;
}

export function MaintenancePanelView({ workOrders, partsInventory }: MaintenancePanelViewProps) {
  const money = useMoney();
  const scope = money.currencyOf();
  const mxn = (n: number) => money.fmtIn(n, scope?.code ?? null);
  const [barTable, setBarTable] = useState(false);
  const [donutTable, setDonutTable] = useState(false);

  const today = localToday();
  const byAsset = useMemo(() => scheduledVsOverdueByAssetType(workOrders, today), [workOrders, today]);
  const consumed = useMemo(
    () =>
      topConsumedParts(
        workOrders,
        partsInventory,
        5,
        money.consolidated ? (o) => money.toScope(o.tenantId, o.completedAt || o.createdAt) : undefined
      ),
    [workOrders, partsInventory, money]
  );

  const totalProgramado = byAsset.reduce((s, r) => s + r.programado, 0);
  const totalVencido = byAsset.reduce((s, r) => s + r.vencido, 0);
  const hasOpenOrders = totalProgramado + totalVencido > 0;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* ------------------------------------------------ Programado vs vencido */}
      <Card
        title="Mantenimiento programado vs vencido"
        subtitle="Órdenes de trabajo abiertas por tipo de activo, según su fecha programada"
        icon={<CalendarClock className="w-4 h-4 text-sky-400" />}
        tableView={barTable}
        onToggleTable={() => setBarTable((v) => !v)}
        summary={
          <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <Swatch color={SERIES.programado} /> Programado: <b className="text-slate-100">{totalProgramado}</b>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Swatch color={SERIES.vencido} />
              <AlertTriangle className="w-3.5 h-3.5 text-rose-300" aria-hidden /> Vencido: <b className="text-slate-100">{totalVencido}</b>
            </span>
          </span>
        }
      >
        {!hasOpenOrders ? (
          <Empty>No hay órdenes de trabajo abiertas.</Empty>
        ) : barTable ? (
          <table className="w-full text-xs">
            <caption className="sr-only">Órdenes abiertas programadas y vencidas por tipo de activo</caption>
            <thead className="text-slate-400">
              <tr>
                <th className="text-left font-medium py-1.5">Tipo de activo</th>
                <th className="text-right font-medium py-1.5">Programado</th>
                <th className="text-right font-medium py-1.5">Vencido</th>
                <th className="text-right font-medium py-1.5">Total abiertas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-200 tabular-nums">
              {byAsset.map((r) => (
                <tr key={r.assetType}>
                  <td className="py-1.5">{r.label}</td>
                  <td className="py-1.5 text-right">{r.programado}</td>
                  <td className="py-1.5 text-right">{r.vencido}</td>
                  <td className="py-1.5 text-right">{r.programado + r.vencido}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="h-64" role="img" aria-label={byAsset.map((r) => `${r.label}: ${r.programado} programadas, ${r.vencido} vencidas`).join('. ')}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={byAsset} margin={{ top: 22, right: 8, left: -18, bottom: 0 }} barGap={2} barCategoryGap="30%">
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: AXIS }} tick={{ fill: INK.secondary, fontSize: 12 }} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: INK.muted, fontSize: 11 }} />
                <Tooltip
                  cursor={{ fill: 'rgba(148,163,184,0.08)' }}
                  content={({ active, payload, label }) =>
                    active && payload?.length ? (
                      <TooltipBox>
                        <div className="font-semibold text-slate-100">{label}</div>
                        {payload.map((p) => (
                          <div key={String(p.dataKey)} className="flex items-center gap-1.5">
                            <Swatch color={String(p.color)} />
                            {p.dataKey === 'vencido' ? 'Vencido' : 'Programado'}:
                            <b className="text-slate-100 tabular-nums">{p.value}</b>
                          </div>
                        ))}
                      </TooltipBox>
                    ) : null
                  }
                />
                <Bar dataKey="programado" name="Programado" fill={SERIES.programado} barSize={24} radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="programado" position="top" fill={INK.primary} fontSize={12} />
                </Bar>
                <Bar dataKey="vencido" name="Vencido" fill={SERIES.vencido} barSize={24} radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="vencido" position="top" fill={INK.primary} fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          Programado: fecha de hoy en adelante. Vencido: fecha anterior a hoy. No incluye órdenes completadas ni canceladas.
        </p>
      </Card>

      {/* ------------------------------------------------ Top 5 repuestos */}
      <Card
        title="5 repuestos más utilizados"
        subtitle="Consumo del almacén, por valor de repuestos en órdenes completadas"
        icon={<Package className="w-4 h-4 text-sky-400" />}
        tableView={donutTable}
        onToggleTable={() => setDonutTable((v) => !v)}
        summary={
          <span>
            Total consumido: <b className="text-slate-100">{mxn(consumed.total)}</b>
            {consumed.otherCount > 0 && (
              <span className="text-slate-400">
                {' '}
                · otros {consumed.otherCount} repuestos: {mxn(consumed.other)}
              </span>
            )}
          </span>
        }
      >
        {consumed.items.length === 0 ? (
          <Empty>Todavía no hay repuestos consumidos: aparecerán al completar órdenes de trabajo con repuestos.</Empty>
        ) : (
          <div className={donutTable ? '' : 'grid grid-cols-1 sm:grid-cols-[minmax(0,15rem)_1fr] gap-4 items-center'}>
            {!donutTable && (
              <div className="relative h-60" role="img" aria-label={consumed.items.map((p) => `${p.name}: ${mxn(p.value)} (${pct(p.share)})`).join('. ')}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={consumed.items}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="62%"
                      outerRadius="92%"
                      startAngle={90}
                      endAngle={-270}
                      stroke={SURFACE}
                      strokeWidth={2}
                      isAnimationActive={false}
                    >
                      {consumed.items.map((p, i) => (
                        <Cell key={p.sku} fill={PART_COLORS[i]} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active, payload }) => {
                        const item = active && payload?.[0] ? (payload[0].payload as (typeof consumed.items)[number]) : null;
                        return item ? (
                          <TooltipBox>
                            <div className="font-semibold text-slate-100">{item.name}</div>
                            <div className="text-slate-400">{item.sku}</div>
                            <div className="tabular-nums">
                              {mxn(item.value)} · {pct(item.share)} · {qty(item.quantity)} {item.unit}
                            </div>
                          </TooltipBox>
                        ) : null;
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[11px] text-slate-400">Total</span>
                  <span className="text-base font-semibold text-slate-100">{mxn(consumed.total)}</span>
                  <span className="text-[11px] text-slate-500">{scope?.code ?? 'sin moneda'}</span>
                </div>
              </div>
            )}
            {/* Legend with every figure (doubles as the table view): identity never relies on color alone. */}
            <table className="w-full text-xs">
              <caption className="sr-only">Repuestos más utilizados por valor consumido</caption>
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left font-medium py-1.5">Repuesto</th>
                  <th className="text-right font-medium py-1.5">Valor</th>
                  <th className="text-right font-medium py-1.5">%</th>
                  <th className="text-right font-medium py-1.5">Cantidad</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-200 tabular-nums">
                {consumed.items.map((p, i) => (
                  <tr key={p.sku}>
                    <td className="py-1.5 pr-2">
                      <div className="flex items-start gap-2">
                        <span className="mt-1">
                          <Swatch color={PART_COLORS[i]} />
                        </span>
                        <div className="min-w-0">
                          <div className="text-slate-100 leading-snug">{p.name}</div>
                          <div className="text-[11px] text-slate-500 font-mono">{p.sku}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-1.5 text-right whitespace-nowrap">{mxn(p.value)}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">{pct(p.share)}</td>
                    <td className="py-1.5 text-right whitespace-nowrap">
                      {qty(p.quantity)} {p.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          Se mide en dinero porque los repuestos usan unidades distintas (pza, cubeta, kit…). No incluye mano de obra ni órdenes abiertas.
        </p>
      </Card>
    </div>
  );
}
