import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO, TestEnv } from './helpers/harness.ts';

const env = new TestEnv();
let norte: string;
let urbana: string;
let monitoreo: string;
let norteData: any;

before(
  async () => {
    await env.start();
    norte = await env.token(...DEMO.norte);
    urbana = await env.token(...DEMO.urbana);
    monitoreo = await env.token(...DEMO.norteMonitoreo);
    norteData = (await env.req('GET', '/api/bootstrap', { token: norte })).json;
  },
  { timeout: 120_000 }
);
after(() => env.close());

describe('conexión de equipos', () => {
  test('el bootstrap trae los datos de conexión y los campos nuevos de cada equipo', () => {
    assert.deepEqual(norteData.deviceConnection, {
      host: 'flota.test.local',
      jt808Port: 5015,
      jt1078Port: 5263,
      teltonikaPort: 5027,
      osmandPort: 5055,
      phoneServerUrl: 'http://flota.test.local:5055',
      phoneServerUrlCustom: false,
      obdHost: 'flota.test.local',
      obdPort: 5027,
      obdServerCustom: false,
      cameraHost: 'flota.test.local',
      cameraJt808Port: 5015,
      cameraVideoHost: 'flota.test.local',
      cameraJt1078Port: 5263,
      cameraServerCustom: false,
      ingestEnabled: true,
    });
    const d = norteData.devices[0];
    assert.match(d.terminalId, /^\d{12}$/);
    assert.equal(d.uplink, 'wifi_starlink');
    assert.equal(d.telemetrySource, 'simulada');
    assert.equal(norteData.unmatchedDevices, undefined, 'solo el superadmin ve equipos sin asignar');
    const ids = new Set(norteData.devices.map((x: any) => x.terminalId));
    assert.equal(ids.size, norteData.devices.length, 'los IDs de terminal son únicos');
  });

  test('editar la conexión de un equipo', async () => {
    const d = norteData.devices[0];
    const res = await env.req('PUT', `/api/devices/${d.id}/connection`, {
      token: norte,
      body: { terminalId: '013800138000', uplink: 'ethernet_starlink', wifiSsid: 'Starlink-Norte-01' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.device.terminalId, '013800138000');
    assert.equal(res.json.device.uplink, 'ethernet_starlink');
    assert.equal(res.json.device.wifiSsid, 'Starlink-Norte-01');
    assert.ok(res.json.auditLogs.some((l: any) => l.action === 'Conexión del equipo'));
  });

  test('ID de terminal duplicado o inválido → 400', async () => {
    const [a, b] = norteData.devices;
    const dup = await env.req('PUT', `/api/devices/${b.id}/connection`, {
      token: norte,
      body: { terminalId: '013800138000', uplink: 'wifi_starlink' },
    });
    assert.equal(dup.status, 400);
    assert.match(dup.json.error, /ya está asignado/);

    const bad = await env.req('PUT', `/api/devices/${a.id}/connection`, {
      token: norte,
      body: { terminalId: 'ABC', uplink: 'wifi_starlink' },
    });
    assert.equal(bad.status, 400);
  });

  test('otra empresa no puede tocar el equipo; un perfil sin permiso tampoco', async () => {
    const d = norteData.devices[1];
    const other = await env.req('PUT', `/api/devices/${d.id}/connection`, {
      token: urbana,
      body: { terminalId: '999999999999', uplink: 'wifi_starlink' },
    });
    assert.equal(other.status, 404);

    const noPerm = await env.req('PUT', `/api/devices/${d.id}/connection`, {
      token: monitoreo,
      body: { terminalId: '999999999999', uplink: 'wifi_starlink' },
    });
    assert.equal(noPerm.status, 403);
  });
});

describe('Servidor de las cámaras editable', () => {
  test('el superadmin cambia host y puertos (con host de video aparte), se rechazan túneles HTTP y se restaura', async () => {
    const superadmin = await env.token(...DEMO.superadmin);
    const put = (token: string, server: unknown) => env.req('PUT', '/api/settings/camera-server', { token, body: { server } });
    const tunnels = { host: '0.tcp.sa.ngrok.io', jt808Port: 14523, videoHost: '2.tcp.sa.ngrok.io', jt1078Port: 18811 };

    assert.equal((await put(norte, tunnels)).status, 403);
    const http = await put(superadmin, { ...tunnels, host: 'cxsxdnnc-5015.brs.devtunnels.ms' });
    assert.equal(http.status, 400);
    assert.match(http.json.error, /solo transmiten HTTP/);
    assert.equal((await put(superadmin, { ...tunnels, videoHost: 'http://x.example.com' })).status, 400);

    const ok = await put(superadmin, tunnels);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const dc = ok.json.deviceConnection;
    assert.equal(dc.cameraHost, '0.tcp.sa.ngrok.io');
    assert.equal(dc.cameraJt808Port, 14523);
    assert.equal(dc.cameraVideoHost, '2.tcp.sa.ngrok.io');
    assert.equal(dc.cameraJt1078Port, 18811);
    assert.equal(dc.cameraServerCustom, true);
    assert.equal(dc.jt808Port, 5015, 'los puertos locales de Traccar no cambian');
    assert.equal(dc.obdHost, 'flota.test.local', 'el OBD no se ve afectado');

    const same = await put(superadmin, { ...tunnels, videoHost: '' });
    assert.equal(same.json.deviceConnection.cameraVideoHost, '0.tcp.sa.ngrok.io', 'video vacío = mismo host');

    const reset = await put(superadmin, null);
    assert.equal(reset.json.deviceConnection.cameraHost, 'flota.test.local');
    assert.equal(reset.json.deviceConnection.cameraJt808Port, 5015);
    assert.equal(reset.json.deviceConnection.cameraServerCustom, false);
  });
});

