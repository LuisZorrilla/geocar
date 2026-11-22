import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function spawnTs(file: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', file, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForLine(child: ChildProcess, pattern: RegExp, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Timeout esperando ${pattern}.\n${output}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El proceso terminó (code ${code}) antes de ${pattern}.\n${output}`));
    });
  });
}

function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

export interface ApiResponse<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

/** In-memory Postgres + the real API server as child processes. */
export class TestEnv {
  private pg: ChildProcess | null = null;
  private app: ChildProcess | null = null;
  private dbPort = 0;
  private appPort = 0;
  seedLog = '';

  constructor(private readonly extraEnv: NodeJS.ProcessEnv = {}) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.appPort}`;
  }

  async start(): Promise<void> {
    this.dbPort = await freePort();
    this.pg = spawnTs('tests/helpers/pgliteServer.ts', [String(this.dbPort)], {});
    await waitForLine(this.pg, /PGLITE_READY/);
    await this.startApp();
  }

  async startApp(): Promise<void> {
    this.appPort = await freePort();
    this.app = spawnTs('server.ts', [], {
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${this.dbPort}/postgres?sslmode=disable`,
      SEED_DEMO_DATA: 'true',
      PORT: String(this.appPort),
      PG_POOL_MAX: '1',
      NODE_ENV: 'test',
      VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
      INGEST_TOKEN: INGEST_TOKEN,
      DEVICE_SERVER_HOST: 'flota.test.local',
      // The developer's .env must not leak into tests (dotenv never overrides set variables).
      SIMULATED_TELEMETRY: 'true',
      // Never reach the developer's real Traccar from tests.
      TRACCAR_WEB_URL: '',
      TRACCAR_ADMIN_EMAIL: '',
      TRACCAR_ADMIN_PASSWORD: '',
      ...this.extraEnv,
    });
    this.seedLog = await waitForLine(this.app, /listening on/);
  }

  async restartApp(): Promise<void> {
    await stop(this.app);
    await this.startApp();
  }

  async close(): Promise<void> {
    await stop(this.app);
    await stop(this.pg);
  }

  async req<T = any>(
    method: string,
    urlPath: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.baseUrl + urlPath, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  }

  login(username: string, password: string) {
    return this.req('POST', '/api/auth/login', { body: { username, password } });
  }

  async token(username: string, password: string): Promise<string> {
    const res = await this.login(username, password);
    if (res.status !== 200) throw new Error(`Login ${username} falló: ${res.status} ${JSON.stringify(res.json)}`);
    return res.json.token;
  }
}

export const INGEST_TOKEN = 'test-ingest-token-0123456789';

export const DEMO = {
  superadmin: ['superadmin', 'SuperAdmin2026!'],
  norte: ['admin.norte', 'Norte2026!'],
  norteMonitoreo: ['monitoreo.norte', 'Norte2026!'],
  norteTaller: ['taller.norte', 'Norte2026!'],
  urbana: ['admin.urbana', 'Urbana2026!'],
  frio: ['admin.frio', 'Frio2026!'],
} as const;
