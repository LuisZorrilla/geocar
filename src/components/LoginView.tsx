import { useState } from 'react';
import { Lock, LogIn } from 'lucide-react';
import type { AuthSessionResponse } from '../shared/types.ts';
import { apiRequest } from '../lib/api.ts';

interface LoginViewProps {
  onLoginSuccess: (session: AuthSessionResponse) => void;
}

export function LoginView({ onLoginSuccess }: LoginViewProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performLogin = async (loginUser: string, loginPass: string) => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiRequest<AuthSessionResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: loginUser, password: loginPass }),
      });
      onLoginSuccess(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No fue posible iniciar sesión.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Ingresa el usuario y contraseña asignados a tu empresa.');
      return;
    }
    performLogin(username, password);
  };

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-md bg-[#11192C] border border-slate-800/90 rounded-2xl overflow-hidden">
        <div className="p-6 sm:p-8 flex flex-col justify-between">
          <div className="space-y-6">
            <div>
              <div className="text-xs font-medium text-sky-400">Acceso BackOffice Multiempresa</div>
              <h1 className="text-2xl font-bold text-slate-100 mt-1">Vigilant FleetOps</h1>
              <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                Cada empresa accede exclusivamente a su flota, maquinaria pesada, mantenimiento, telemetría Esri y evidencia de video JT1078.
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 mb-1.5">Usuario</label>
                <input
                  type="text"
                  autoComplete="username"
                  placeholder="Usuario asignado por tu empresa"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 mb-1.5">Contraseña</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-[#0B1120] border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white transition-colors cursor-pointer"
              >
                <LogIn className="w-4 h-4" />
                {submitting ? 'Validando credenciales...' : 'Iniciar sesión'}
              </button>
            </form>
          </div>

          <div className="pt-6 mt-6 border-t border-slate-800/80 flex items-center gap-2 text-xs text-slate-400">
            <Lock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>Aislamiento estricto por empresa y perfil RBAC verificado en servidor.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
