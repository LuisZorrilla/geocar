import { useState } from 'react';
import QRCode from 'qrcode';
import { Copy, KeyRound, Loader2, MessageCircle, ShieldOff, Smartphone } from 'lucide-react';
import type { Driver } from '../../shared/types.ts';
import { apiRequest } from '../../lib/api.ts';
import { Dialog, btnGhost, btnPrimary, errMsg, fmtDateTime } from './ui.tsx';

/**
 * Personal link to the driver's trips app. The token is shown only once (the server keeps its
 * hash): generating a new one replaces the previous link.
 */
export function DriverAppLinkDialog({ driver, onClose, onChanged }: { driver: Pick<Driver, 'id' | 'name' | 'phone' | 'appAccess'>; onClose: () => void; onChanged: () => void }) {
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [active, setActive] = useState(Boolean(driver.appAccess));

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<{ path: string }>(`/api/tms/drivers/${driver.id}/app-link`, { method: 'POST' });
      const url = `${window.location.origin}${res.path}`;
      setLink({ url, qr: await QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: 'M' }) });
      setActive(true);
      onChanged();
    } catch (err) {
      setError(errMsg(err, 'No se pudo generar el link.'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/tms/drivers/${driver.id}/app-link`, { method: 'DELETE' });
      setLink(null);
      setActive(false);
      onChanged();
    } catch (err) {
      setError(errMsg(err, 'No se pudo revocar.'));
    } finally {
      setBusy(false);
    }
  };

  const phoneDigits = (driver.phone ?? '').replace(/\D/g, '');
  const waText = link ? encodeURIComponent(`Hola ${driver.name.split(',').reverse().join(' ').trim()}, este es tu acceso a la app de viajes: ${link.url}\nAbrilo desde tu celular (no lo compartas).`) : '';

  return (
    <Dialog title={`App de viajes · ${driver.name}`} subtitle="El chofer ve sus viajes, marca llegadas y registra las entregas con firma" onClose={onClose}>
      <div className="space-y-4">
        {error && <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>}
        <div className="flex items-start gap-3 p-3 rounded-lg border border-slate-800 bg-[#11192C]">
          <Smartphone className="w-5 h-5 text-sky-400 shrink-0" aria-hidden />
          <div className="text-slate-300">
            {active ? (
              <>
                <div className="text-emerald-300 font-medium">Acceso activo</div>
                {driver.appAccess && (
                  <div className="text-slate-400">
                    Generado {fmtDateTime(driver.appAccess.createdAt)} por {driver.appAccess.createdBy}
                    {driver.appAccess.lastSeenAt ? ` · último uso ${fmtDateTime(driver.appAccess.lastSeenAt)}` : ' · todavía sin usar'}
                  </div>
                )}
              </>
            ) : (
              <div>El chofer todavía no tiene acceso a la app.</div>
            )}
          </div>
        </div>

        {link ? (
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200">
              Este link se muestra <strong>una sola vez</strong>. Mandáselo ahora al chofer: quien lo tenga entra como él. Si se pierde, generá uno nuevo (el anterior deja de funcionar).
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-4">
              <img src={link.qr} alt={`Código QR del link de ${driver.name}`} className="w-52 h-52 rounded-lg bg-white p-2" />
              <div className="flex-1 space-y-2 w-full">
                <p className="text-slate-400">Que lo escanee con la cámara del celular, o mandale el link:</p>
                <div className="font-mono text-[11px] break-all p-2 rounded bg-[#0B1120] border border-slate-800 text-slate-300">{link.url}</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => {
                      void navigator.clipboard.writeText(link.url).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      });
                    }}
                  >
                    <Copy className="w-3.5 h-3.5" /> {copied ? 'Copiado' : 'Copiar link'}
                  </button>
                  <a className={`${btnGhost} text-emerald-300`} href={`https://wa.me/${phoneDigits}?text=${waText}`} target="_blank" rel="noreferrer">
                    <MessageCircle className="w-3.5 h-3.5" /> Enviar por WhatsApp
                  </a>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-slate-800">
          {active ? (
            <button type="button" className={`${btnGhost} text-rose-300`} disabled={busy} onClick={() => void revoke()}>
              <ShieldOff className="w-3.5 h-3.5" /> Revocar acceso
            </button>
          ) : (
            <span />
          )}
          <button type="button" className={btnPrimary} disabled={busy} onClick={() => void generate()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />} {active ? 'Generar link nuevo' : 'Generar link de acceso'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
