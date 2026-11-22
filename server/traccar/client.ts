/**
 * Minimal client for the Traccar REST API (devices and commands).
 *
 * Uses TRACCAR_WEB_URL + TRACCAR_ADMIN_EMAIL/TRACCAR_ADMIN_PASSWORD (Basic auth). Without
 * credentials it is "not configured" and the panel falls back to creating devices by hand.
 */

export class TraccarError extends Error {}

export interface TraccarDevice {
  id: number;
  name: string;
  uniqueId: string;
  status?: string;
  lastUpdate?: string | null;
}

const TIMEOUT_MS = 5000;

function settings() {
  return {
    url: (process.env.TRACCAR_WEB_URL || '').trim().replace(/\/+$/, ''),
    email: (process.env.TRACCAR_ADMIN_EMAIL || '').trim(),
    password: process.env.TRACCAR_ADMIN_PASSWORD || '',
  };
}

export function isTraccarConfigured(): boolean {
  const s = settings();
  return Boolean(s.url && s.email && s.password);
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const s = settings();
  if (!s.url || !s.email || !s.password) {
    throw new TraccarError('La API de Traccar no está configurada (TRACCAR_WEB_URL, TRACCAR_ADMIN_EMAIL y TRACCAR_ADMIN_PASSWORD).');
  }
  let res: Response;
  try {
    res = await fetch(`${s.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.email}:${s.password}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new TraccarError(timeout ? 'Traccar no respondió a tiempo.' : `No se pudo conectar con Traccar en ${s.url}.`);
  }
  if (res.status === 401) throw new TraccarError('Traccar rechazó el usuario o la contraseña de administrador.');
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new TraccarError(`Traccar respondió ${res.status}${text ? `: ${text}` : ''}.`);
  }
  return res;
}

export async function findDevice(uniqueId: string): Promise<TraccarDevice | null> {
  const res = await call('GET', `/api/devices?uniqueId=${encodeURIComponent(uniqueId)}`);
  const list = (await res.json()) as TraccarDevice[];
  return list.find((d) => d.uniqueId === uniqueId) ?? null;
}

/** Creates the device or renames the existing one. Returns the Traccar device. */
export async function ensureDevice(input: { uniqueId: string; name: string }): Promise<TraccarDevice> {
  const existing = await findDevice(input.uniqueId);
  if (!existing) {
    const res = await call('POST', '/api/devices', { name: input.name, uniqueId: input.uniqueId });
    return (await res.json()) as TraccarDevice;
  }
  if (existing.name !== input.name) {
    const res = await call('PUT', `/api/devices/${existing.id}`, { ...existing, name: input.name });
    return (await res.json()) as TraccarDevice;
  }
  return existing;
}

export async function deleteDevice(id: number): Promise<void> {
  await call('DELETE', `/api/devices/${id}`);
}

/**
 * Sends a Teltonika text command (Codec 12 over GPRS). Traccar answers 200 when the device is
 * online and the command was written to it, 202 when it was queued until the device connects.
 */
export async function sendCustomCommand(deviceId: number, data: string): Promise<'enviado' | 'en_cola'> {
  const res = await call('POST', '/api/commands/send', { deviceId, type: 'custom', attributes: { data } });
  return res.status === 202 ? 'en_cola' : 'enviado';
}
