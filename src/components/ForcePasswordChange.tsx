import { useState, type FormEvent } from 'react';
import { Check, KeyRound, LogOut, X } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';

interface ForcePasswordChangeProps {
  userName: string;
  username: string;
  tenantName: string;
  onChanged: () => Promise<void> | void;
  onLogout: () => void;
}

/** Shown instead of the panel while the user still has a temporary password. */
export function ForcePasswordChange({ userName, username, tenantName, onChanged, onLogout }: ForcePasswordChangeProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = [
    { ok: next.length >= 10, label: 'Al menos 10 caracteres' },
    { ok: /[A-Za-z]/.test(next) && /\d/.test(next), label: 'Letras y números' },
    { ok: next.length > 0 && next !== current, label: 'Distinta de la contraseña temporal' },
    { ok: next.length > 0 && next === confirm, label: 'Las dos contraseñas coinciden' },
  ];
  const valid = current.length > 0 && rules.every((r) => r.ok);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar la contraseña.');
      setSubmitting(false);
    }
  };

  const input =
    'w-full px-3.5 py-2.5 bg-[#0B1120] border border-slate-800 rounded-lg text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500';

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-[#11192C] border border-slate-800/90 rounded-2xl p-6 sm:p-8 space-y-5" noValidate>
        <div className="space-y-2">
          <div className="w-10 h-10 rounded-lg bg-sky-600/15 border border-sky-500/30 flex items-center justify-center">
            <KeyRound className="w-5 h-5 text-sky-400" />
          </div>
          <h1 className="text-xl font-bold">Crea tu contraseña</h1>
          <p className="text-sm text-slate-400">
            Hola {userName}. Ingresaste a <b className="text-slate-200">{tenantName}</b> con una contraseña temporal. Para proteger la cuenta,
            elige una contraseña propia antes de continuar.
          </p>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
            {error}
          </div>
        )}

        {/* Lets password managers associate the new password with this account. */}
        <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />

        <div className="space-y-1.5">
          <label htmlFor="fpc-current" className="block text-xs text-slate-300">
            Contraseña temporal
          </label>
          <input id="fpc-current" type="password" autoComplete="current-password" className={input} value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="fpc-new" className="block text-xs text-slate-300">
            Nueva contraseña
          </label>
          <input id="fpc-new" type="password" autoComplete="new-password" className={input} value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="fpc-confirm" className="block text-xs text-slate-300">
            Repite la nueva contraseña
          </label>
          <input id="fpc-confirm" type="password" autoComplete="new-password" className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        <ul className="space-y-1 text-xs" aria-label="Requisitos de la contraseña">
          {rules.map((r) => (
            <li key={r.label} className={`flex items-center gap-1.5 ${r.ok ? 'text-emerald-300' : 'text-slate-400'}`}>
              {r.ok ? <Check className="w-3.5 h-3.5" aria-hidden /> : <X className="w-3.5 h-3.5" aria-hidden />}
              {r.label}
              <span className="sr-only">{r.ok ? '(cumplido)' : '(pendiente)'}</span>
            </li>
          ))}
        </ul>

        <button
          type="submit"
          disabled={!valid || submitting}
          className="w-full px-4 py-2.5 rounded-lg text-sm font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white cursor-pointer"
        >
          {submitting ? 'Guardando…' : 'Guardar y entrar al panel'}
        </button>
        <button type="button" onClick={onLogout} className="w-full inline-flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer">
          <LogOut className="w-3.5 h-3.5" /> Salir
        </button>
      </form>
    </div>
  );
}
