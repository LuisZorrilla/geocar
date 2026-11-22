import http from 'node:http';
import { freePort } from './harness.ts';

/** In-process fake of the Traccar REST API (devices + commands). */
export class FakeTraccar {
  devices = new Map<number, { id: number; name: string; uniqueId: string }>();
  commands: { deviceId: number; data: string }[] = [];
  nextId = 100;
  fail = false;
  queued = false;
  private server = http.createServer((req, res) => this.handle(req, res));
  port = 0;

  async start() {
    this.port = await freePort();
    await new Promise<void>((r) => this.server.listen(this.port, '127.0.0.1', r));
  }
  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  byUniqueId(uniqueId: string) {
    return [...this.devices.values()].find((d) => d.uniqueId === uniqueId);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const expected = `Basic ${Buffer.from('admin@test:secret').toString('base64')}`;
      if (req.headers.authorization !== expected) return send(401);
      if (this.fail) return send(500, { message: 'boom' });
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      const m = url.pathname.match(/^\/api\/devices\/(\d+)$/);
      if (req.method === 'GET' && url.pathname === '/api/devices') {
        const u = url.searchParams.get('uniqueId');
        return send(200, [...this.devices.values()].filter((d) => !u || d.uniqueId === u));
      }
      if (req.method === 'POST' && url.pathname === '/api/devices') {
        const d = { id: this.nextId++, name: body.name, uniqueId: body.uniqueId };
        this.devices.set(d.id, d);
        return send(200, d);
      }
      if (req.method === 'PUT' && m) {
        const d = { ...this.devices.get(Number(m[1]))!, name: body.name };
        this.devices.set(d.id, d);
        return send(200, d);
      }
      if (req.method === 'DELETE' && m) {
        this.devices.delete(Number(m[1]));
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/commands/send') {
        this.commands.push({ deviceId: body.deviceId, data: body.attributes?.data });
        return send(this.queued ? 202 : 200, body);
      }
      send(404);
    });
  }
}

export const FAKE_TRACCAR_ENV = (port: number) => ({
  TRACCAR_WEB_URL: `http://127.0.0.1:${port}`,
  TRACCAR_ADMIN_EMAIL: 'admin@test',
  TRACCAR_ADMIN_PASSWORD: 'secret',
});
