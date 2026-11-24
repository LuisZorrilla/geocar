import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileText, KeyRound, Loader2, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import { invoiceNumber, LETTER_LABEL, type ArcaConfig, type Invoice } from '../../shared/billing.ts';
import { apiRequest, openWithAuth } from '../../lib/api.ts';
import { useMoney } from '../../lib/money.tsx';
import { ReasonDialog } from './OrdersPanel.tsx';
import { Dialog, Field, btnGhost, btnPrimary, errMsg, fmtDateTime, inputCls } from './ui.tsx';

type Notify = (text: string, tone?: 'ok' | 'warn' | 'err') => void;
type InvoiceRow = Invoice & { customerName: string };
const card = 'bg-[#11192C] border border-slate-800/80 rounded-xl';

const IVA_LABEL: Record<ArcaConfig['ivaCondition'], string> = {
  responsable_inscripto: 'Responsable Inscripto (factura A/B)',
  monotributo: 'Monotributo (factura C)',
  exento: 'Exento (factura C)',
};

function modeOf(cfg: ArcaConfig | null): { label: string; tone: string } {
  if (!cfg) return { label: '...', tone: 'text-slate-400' };
  if (!cfg.hasCertificate) return { label: 'Modo simulado (sin validez fiscal)', tone: 'text-amber-300' };
  return cfg.environment === 'produccion' ? { label: 'ARCA producción', tone: 'text-emerald-300' } : { label: 'ARCA homologación (pruebas)', tone: 'text-sky-300' };
}

/** Electronic invoices: ARCA status/config (admins) and the list of invoices and credit notes. */
export function InvoicesSection({ canApprove, notify, reloadKey, onChanged }: { canApprove: boolean; notify: Notify; reloadKey: number; onChanged: () => void }) {
  const money = useMoney();
  const [items, setItems] = useState<InvoiceRow[] | null>(null);
  const [cfg, setCfg] = useState<ArcaConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [crediting, setCrediting] = useState<InvoiceRow | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiRequest<{ items: InvoiceRow[] }>('/api/billing/invoices');
      setItems(r.items);
    } catch (err) {
      notify(errMsg(err, 'No se pudieron cargar los comprobantes.'), 'err');
    }
    if (canApprove) {
      try {
        const r = await apiRequest<{ config: ArcaConfig }>('/api/billing/arca-config');
        setCfg(r.config);
        setCfgError(null);
      } catch (err) {
        setCfgError(errMsg(err, 'No se pudo leer la configuración de ARCA.'));
      }
    }
  }, [canApprove, notify]);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const mode = modeOf(cfg);
  const pdf = (i: InvoiceRow) => void openWithAuth(`/api/billing/invoices/${encodeURIComponent(i.id)}/pdf`).catch((err) => notify(errMsg(err, 'No se pudo abrir el PDF.'), 'err'));

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Facturas electrónicas</h2>
          <p className="text-xs text-slate-400">Facturas y notas de crédito emitidas desde pre-facturas, con CAE y QR fiscal de ARCA.</p>
        </div>
        {canApprove && (
          <div className="flex items-center gap-2">
            <span className={`text-xs font-medium ${cfgError ? 'text-slate-400' : mode.tone}`}>{cfgError ?? mode.label}</span>
            <button type="button" className={btnGhost} onClick={() => setConfigOpen(true)} disabled={Boolean(cfgError)}>
              <Settings2 className="w-3.5 h-3.5" /> Configurar ARCA
            </button>
          </div>
        )}
      </div>
      {canApprove && cfg && !cfg.hasCertificate && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>Sin certificado de ARCA los comprobantes se generan <b>simulados</b>: llevan la marca «SIN VALIDEZ FISCAL» y no se informan a ARCA. Cargá el certificado en «Configurar ARCA» para emitir facturas reales.</span>
        </div>
      )}
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 bg-[#0F172A]">
              <th className="py-2.5 px-3 font-medium">Comprobante</th>
              <th className="py-2.5 px-3 font-medium">Cliente</th>
              <th className="py-2.5 px-3 font-medium">Fecha</th>
              <th className="py-2.5 px-3 font-medium text-right">Total</th>
              <th className="py-2.5 px-3 font-medium">CAE</th>
              <th className="py-2.5 px-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {items?.map((i) => (
              <tr key={i.id} className="hover:bg-slate-800/30">
                <td className="py-2 px-3">
                  <div className="font-medium text-slate-100">
                    {LETTER_LABEL[i.kind]} {i.letter} <span className="font-mono">{invoiceNumber(i.pointOfSale, i.number)}</span>
                  </div>
                  <div className="text-slate-500">
                    {i.preInvoiceId ? `De ${i.preInvoiceId}` : ''}
                    {i.creditNoteId && <span className="text-rose-300"> · anulada con nota de crédito</span>}
                    {i.reason && <span> · {i.reason}</span>}
                  </div>
                </td>
                <td className="py-2 px-3 text-slate-200">{i.customerName}<div className="text-slate-500">{i.receiver.ivaConditionLabel}</div></td>
                <td className="py-2 px-3 font-mono text-slate-300">{i.date.slice(0, 10)}</td>
                <td className={`py-2 px-3 text-right font-mono ${i.kind === 'nota_credito' ? 'text-rose-300' : 'text-slate-100'}`}>
                  {i.kind === 'nota_credito' ? '-' : ''}
                  {money.fmtIn(i.total, 'ARS')}
                </td>
                <td className="py-2 px-3">
                  {i.status === 'simulada' ? (
                    <span className="text-amber-300 font-medium">Simulado</span>
                  ) : (
                    <span className="font-mono text-slate-200">
                      {i.cae}
                      {i.environment === 'homologacion' && <span className="ml-1 text-sky-300 font-sans">(homologación)</span>}
                    </span>
                  )}
                  <div className="text-slate-500">Vence {i.caeDue.slice(0, 10)}</div>
                </td>
                <td className="py-2 px-3">
                  <div className="flex justify-end items-center gap-1">
                    <button type="button" className={btnGhost} onClick={() => pdf(i)}>
                      <FileText className="w-3.5 h-3.5" /> PDF
                    </button>
                    {canApprove && i.kind === 'factura' && !i.creditNoteId && (
                      <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => setCrediting(i)}>
                        Nota de crédito
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items && items.length === 0 && <div className="p-6 text-center text-slate-400">Todavía no hay facturas. Emití una pre-factura y usá «Facturar».</div>}
      </div>

      {configOpen && cfg && (
        <ArcaConfigDialog
          initial={cfg}
          notify={notify}
          onClose={() => setConfigOpen(false)}
          onChanged={(c) => setCfg(c)}
        />
      )}
      {crediting && (
        <ReasonDialog
          title={`Nota de crédito para ${LETTER_LABEL[crediting.kind]} ${crediting.letter} ${invoiceNumber(crediting.pointOfSale, crediting.number)}`}
          description="Anula la factura por el total. La pre-factura vuelve a quedar emitida y sin factura."
          action="Emitir nota de crédito"
          onClose={() => setCrediting(null)}
          onSubmit={async (reason) => {
            const r = await apiRequest<{ invoice: Invoice }>(`/api/billing/invoices/${encodeURIComponent(crediting.id)}/credit-note`, { method: 'POST', body: JSON.stringify({ reason }) });
            setCrediting(null);
            notify(`Nota de crédito ${r.invoice.letter} ${invoiceNumber(r.invoice.pointOfSale, r.invoice.number)} emitida.`, 'warn');
            void load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

type TestResult = { ok: boolean; mode: string; message: string; last?: Record<string, number>; details?: unknown };

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/pkcs10' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function ArcaConfigDialog({ initial, notify, onClose, onChanged }: { initial: ArcaConfig; notify: Notify; onClose: () => void; onChanged: (c: ArcaConfig) => void }) {
  const [cfg, setCfg] = useState(initial);
  const [form, setForm] = useState({
    environment: initial.environment,
    cuit: initial.cuit,
    pointOfSale: String(initial.pointOfSale || ''),
    ivaCondition: initial.ivaCondition,
    ivaRate: String(initial.ivaRate),
    businessName: initial.businessName,
    address: initial.address,
    iibb: initial.iibb,
    activityStart: initial.activityStart,
    paymentDays: String(initial.paymentDays),
  });
  const [certPem, setCertPem] = useState('');
  const [keyPem, setKeyPem] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const changed = (c: ArcaConfig) => {
    setCfg(c);
    onChanged(c);
  };
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err, 'No se pudo completar.'));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      const r = await apiRequest<{ config: ArcaConfig }>('/api/billing/arca-config', {
        method: 'PUT',
        body: JSON.stringify({ ...form, pointOfSale: Number(form.pointOfSale) || undefined, ivaRate: Number(form.ivaRate), paymentDays: Number(form.paymentDays) || 0 }),
      });
      changed(r.config);
      notify('Datos fiscales guardados.');
    });
  const csr = () =>
    run('csr', async () => {
      const r = await apiRequest<{ csrPem: string }>('/api/billing/arca-config/csr', { method: 'POST' });
      downloadText(`pedido-certificado-${cfg.cuit || 'arca'}.csr`, r.csrPem);
      changed({ ...cfg, csrPending: true });
      notify('Pedido de certificado (CSR) descargado. Subilo en ARCA y pegá acá el certificado que te devuelve.');
    });
  const upload = () =>
    run('cert', async () => {
      const r = await apiRequest<{ config: ArcaConfig }>('/api/billing/arca-config/certificate', { method: 'POST', body: JSON.stringify({ certPem, ...(keyPem.trim() ? { keyPem } : {}) }) });
      changed(r.config);
      setCertPem('');
      setKeyPem('');
      notify('Certificado cargado.');
    });
  const remove = () =>
    run('remove', async () => {
      if (!window.confirm('¿Quitar el certificado? Los comprobantes nuevos vuelven a ser simulados.')) return;
      const r = await apiRequest<{ config: ArcaConfig }>('/api/billing/arca-config/certificate', { method: 'DELETE' });
      changed(r.config);
      setTest(null);
      notify('Certificado quitado.', 'warn');
    });
  const probe = () =>
    run('test', async () => {
      setTest(await apiRequest<TestResult>('/api/billing/arca-config/test', { method: 'POST' }));
    });

  const spin = (name: string) => (busy === name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null);

  return (
    <Dialog title="Facturación electrónica ARCA" subtitle={modeOf(cfg).label} onClose={onClose} wide>
      <div className="space-y-5">
        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Datos del emisor</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field id="arca-name" label="Razón social">
              <input id="arca-name" className={inputCls} value={form.businessName} onChange={set('businessName')} />
            </Field>
            <Field id="arca-cuit" label="CUIT" hint="11 dígitos, con o sin guiones.">
              <input id="arca-cuit" className={inputCls} value={form.cuit} onChange={set('cuit')} inputMode="numeric" />
            </Field>
            <Field id="arca-address" label="Domicilio comercial">
              <input id="arca-address" className={inputCls} value={form.address} onChange={set('address')} />
            </Field>
            <Field id="arca-iva" label="Condición frente al IVA">
              <select id="arca-iva" className={inputCls} value={form.ivaCondition} onChange={set('ivaCondition')}>
                {Object.entries(IVA_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            <Field id="arca-pos" label="Punto de venta" hint="Uno habilitado para «Web Services» en ARCA.">
              <input id="arca-pos" className={inputCls} value={form.pointOfSale} onChange={set('pointOfSale')} inputMode="numeric" />
            </Field>
            <Field id="arca-rate" label="Alícuota de IVA del flete">
              <select id="arca-rate" className={inputCls} value={form.ivaRate} onChange={set('ivaRate')} disabled={form.ivaCondition !== 'responsable_inscripto'}>
                <option value="21">21 %</option>
                <option value="10.5">10,5 %</option>
                <option value="27">27 %</option>
              </select>
            </Field>
            <Field id="arca-iibb" label="Ingresos Brutos">
              <input id="arca-iibb" className={inputCls} value={form.iibb} onChange={set('iibb')} />
            </Field>
            <Field id="arca-start" label="Inicio de actividades">
              <input id="arca-start" type="date" className={inputCls} value={form.activityStart} onChange={set('activityStart')} />
            </Field>
            <Field id="arca-days" label="Plazo de pago (días)">
              <input id="arca-days" className={inputCls} value={form.paymentDays} onChange={set('paymentDays')} inputMode="numeric" />
            </Field>
            <Field id="arca-env" label="Entorno de ARCA" hint="Homologación es el entorno de pruebas: los CAE no tienen validez fiscal.">
              <select id="arca-env" className={inputCls} value={form.environment} onChange={set('environment')}>
                <option value="homologacion">Homologación (pruebas)</option>
                <option value="produccion">Producción</option>
              </select>
            </Field>
          </div>
          <div className="flex justify-end">
            <button type="button" className={btnPrimary} onClick={() => void save()} disabled={busy !== null}>
              {spin('save')} Guardar datos
            </button>
          </div>
        </section>

        <section className="space-y-3 border-t border-slate-800 pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Certificado</h3>
          {cfg.hasCertificate ? (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
              <div className="flex gap-2">
                <ShieldCheck className="w-4 h-4 shrink-0 mt-px" />
                <div>
                  <div className="font-medium">Certificado cargado{cfg.encrypted ? ' (guardado cifrado)' : ''}</div>
                  <div className="text-emerald-200/80 break-all">{cfg.certSubject}</div>
                  {cfg.certNotAfter && <div className="text-emerald-200/80">Vence {fmtDateTime(cfg.certNotAfter)}</div>}
                </div>
              </div>
              <button type="button" className={`${btnGhost} text-rose-300`} onClick={() => void remove()} disabled={busy !== null}>
                {spin('remove') ?? <Trash2 className="w-3.5 h-3.5" />} Quitar
              </button>
            </div>
          ) : (
            <ol className="list-decimal pl-5 space-y-1 text-xs text-slate-300">
              <li>Guardá el CUIT y generá el pedido de certificado (CSR). La clave privada se crea y queda en el servidor: nunca se descarga.</li>
              <li>En ARCA, con clave fiscal: «Administración de certificados digitales» (producción) o «WSASS» (homologación). Subí el CSR y descargá el certificado.</li>
              <li>Asociá el certificado al servicio «wsfe» en el «Administrador de relaciones».</li>
              <li>Pegá el certificado abajo y probá la conexión.</li>
            </ol>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnGhost} onClick={() => void csr()} disabled={busy !== null || !cfg.cuit}>
              {spin('csr') ?? <Download className="w-3.5 h-3.5" />} {cfg.csrPending ? 'Generar un CSR nuevo' : 'Generar pedido de certificado (CSR)'}
            </button>
            {cfg.csrPending && <span className="self-center text-xs text-amber-300">Hay un CSR esperando su certificado.</span>}
          </div>
          <Field id="arca-cert" label="Certificado (.crt / .pem)" hint="Pegá el texto completo, desde -----BEGIN CERTIFICATE-----.">
            <textarea id="arca-cert" className={`${inputCls} font-mono text-[11px] h-24`} value={certPem} onChange={(e) => setCertPem(e.target.value)} spellCheck={false} />
          </Field>
          <details className="text-xs text-slate-400">
            <summary className="cursor-pointer">Ya tengo la clave privada (certificado generado fuera del sistema)</summary>
            <div className="mt-2">
              <Field id="arca-key" label="Clave privada (PEM)" hint="Solo si el CSR no se generó acá. Se guarda en el servidor y no vuelve a mostrarse.">
                <textarea id="arca-key" className={`${inputCls} font-mono text-[11px] h-24`} value={keyPem} onChange={(e) => setKeyPem(e.target.value)} spellCheck={false} autoComplete="off" />
              </Field>
            </div>
          </details>
          <div className="flex justify-end">
            <button type="button" className={btnPrimary} onClick={() => void upload()} disabled={busy !== null || !certPem.trim()}>
              {spin('cert') ?? <KeyRound className="w-3.5 h-3.5" />} Cargar certificado
            </button>
          </div>
        </section>

        <section className="space-y-2 border-t border-slate-800 pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Conexión</h3>
            <button type="button" className={btnGhost} onClick={() => void probe()} disabled={busy !== null}>
              {spin('test')} Probar conexión
            </button>
          </div>
          {test && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${test.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100' : 'border-rose-500/30 bg-rose-500/10 text-rose-100'}`}>
              <div className="flex items-center gap-1.5 font-medium">
                {test.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />} {test.message}
              </div>
              {test.last && (
                <div className="mt-1 font-mono">
                  {Object.entries(test.last).map(([k, v]) => (
                    <div key={k}>Último {k}: {v}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
        {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">{error}</div>}
      </div>
    </Dialog>
  );
}
