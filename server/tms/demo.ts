import type { Tenant, Vehicle } from '../../src/shared/types.ts';
import type { Customer, Place, PlaceKind, TransportOrder } from '../../src/shared/tms.ts';
import { DEFAULT_PRIORITY, type Tariff } from '../../src/shared/costs.ts';
import type { Driver } from '../../src/shared/types.ts';
import { MAP_REGION } from '../../src/shared/region.ts';

/**
 * Demo TMS data (only with SEED_DEMO_DATA): per company, 3 customers, 6 places around its hubs and
 * 4 orders (3 confirmed, 1 draft). Also gives demo trucks a load capacity. No trips: those are
 * planned by the user.
 */
export function buildTmsDemo(tenants: Tenant[], vehicles: Vehicle[], codeOf: (tenantId: string) => string, drivers: Driver[] = []) {
  const customers: Customer[] = [];
  const places: Place[] = [];
  const transportOrders: TransportOrder[] = [];
  const tariffs: Tariff[] = [];
  const at = new Date().toISOString();
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const h = (dayOffset: number, hour: number) => new Date(day.getTime() + dayOffset * 86_400_000 + hour * 3_600_000).toISOString();

  const CUSTOMER_NAMES = [
    ['Distribuidora Cuyo S.A.', '30-71234567-1'],
    ['Agroindustrias del Valle S.R.L.', '30-70987654-6'],
    ['Minera Andina Sur S.A.', '30-69876543-8'],
  ] as const;

  tenants.forEach((tenant, ti) => {
    const hubs = MAP_REGION.hubs.filter((hb) => tenant.branches.includes(hb.branch));
    const base = hubs.length ? hubs : MAP_REGION.hubs.slice(0, 2);
    const cust = CUSTOMER_NAMES.map(([name, taxId], i) => {
      const c: Customer = {
        id: `cli-demo-${ti}-${i}`,
        tenantId: tenant.id,
        name,
        taxId,
        taxCondition: 'Responsable inscripto',
        contacts: [{ name: ['Laura Gómez', 'Pablo Ruiz', 'Marta Díaz'][i], phone: `+54 264 4${String(500000 + i * 1111 + ti)}` }],
        active: true,
        createdAt: at,
        updatedAt: at,
      };
      customers.push(c);
      return c;
    });
    const spots: Array<[string, PlaceKind, number, number, string | undefined]> = [
      ['Depósito central', 'deposito', 0, 0, undefined],
      ['Centro de distribución Cuyo', 'cliente', 0.012, 0.018, cust[0].id],
      ['Planta Agroindustrias', 'planta', -0.02, 0.025, cust[1].id],
      ['Acopio Valle Fértil', 'cliente', 0.03, -0.015, cust[1].id],
      ['Yacimiento Andina — portería', 'cliente', -0.028, -0.03, cust[2].id],
      ['Playa de transferencia norte', 'deposito', 0.04, 0.005, undefined],
    ];
    const ps = spots.map(([name, kind, dLat, dLng, customerId], i) => {
      const hub = base[i % base.length];
      const p: Place = {
        id: `lug-demo-${ti}-${i}`,
        tenantId: tenant.id,
        customerId,
        name,
        kind,
        address: `${hub.city}, ${MAP_REGION.name}`,
        lat: Number((hub.lat + dLat).toFixed(6)),
        lng: Number((hub.lng + dLng).toFixed(6)),
        radiusM: kind === 'deposito' ? 250 : 150,
        openingHours: 'Lun a vie 7 a 18 h',
        active: true,
        createdAt: at,
        updatedAt: at,
      };
      places.push(p);
      return p;
    });
    // A sample price list per customer: fixed price for its usual route, per pallet and per km.
    cust.forEach((c, i) => {
      const own = ps.filter((p) => p.customerId === c.id);
      tariffs.push({
        id: `tar-demo-${ti}-${i}`,
        tenantId: tenant.id,
        customerId: c.id,
        name: `Tarifario 2026 · ${c.name}`,
        active: true,
        priority: [...DEFAULT_PRIORITY],
        rules: [
          ...(own[0] ? [{ id: `r-${ti}-${i}-t`, kind: 'tramo' as const, originPlaceId: ps[0].id, destinationPlaceId: own[0].id, bothWays: true, price: 95000 + i * 15000 }] : []),
          { id: `r-${ti}-${i}-p`, kind: 'pallet' as const, price: 9500, minimum: 60000 },
          { id: `r-${ti}-${i}-k`, kind: 'km' as const, price: 1800, minimum: 55000 },
        ],
        extras: { waitingPerHour: 18000, waitingFreeMinutes: 60, dangerousPct: 25, refrigeratedPct: 15, tollsPassThrough: true },
        createdAt: at,
        updatedAt: at,
      });
    });
    const code = codeOf(tenant.id);
    const orders: Array<[number, number, number, string, number, boolean | undefined]> = [
      [0, 0, 1, 'Bebidas en pallets', 8000, undefined],
      [1, 2, 3, 'Fertilizante en bolsas', 12000, undefined],
      [2, 0, 4, 'Repuestos mineros', 3500, undefined],
      [0, 5, 1, 'Mercadería seca (borrador)', 5000, true],
    ];
    orders.forEach(([ci, from, to, description, kg, draft], i) => {
      transportOrders.push({
        id: `PED-${code}-${String(i + 1).padStart(4, '0')}`,
        tenantId: tenant.id,
        customerId: cust[ci].id,
        originPlaceId: ps[from].id,
        destinationPlaceId: ps[to].id,
        cargo: { description, weightKg: kg, pallets: Math.round(kg / 800) },
        pickupWindow: { from: h(1, 7 + i), to: h(1, 9 + i) },
        deliveryWindow: { from: h(1, 10 + i), to: h(1, 15 + i) },
        reference: `OC-${4500 + i}`,
        status: draft ? 'borrador' : 'confirmado',
        createdBy: 'Datos demo',
        createdAt: at,
        updatedAt: at,
      });
    });
  });

  // Demo trucks get a load capacity (machinery doesn't carry orders).
  for (const v of vehicles) {
    if (v.assetType !== 'vehiculo' || v.capacityKg !== undefined) continue;
    const heavy = /Kenworth|Freightliner|Hino/i.test(v.brandModel);
    v.capacityKg = heavy ? 24000 : 3500;
    v.capacityM3 = heavy ? 80 : 14;
    v.capacityPallets = heavy ? 26 : 6;
    v.bodyType = 'caja_seca';
    v.refrigerated = false;
    v.tankLiters = heavy ? 400 : 80;
  }
  for (const d of drivers) d.monthlyCost ??= 1_450_000;
  return { customers, places, transportOrders, trips: [], tariffs, fuelLoads: [], tripExpenses: [], preInvoices: [], driverSettlements: [], invoices: [], apiKeys: [], webhooks: [], webhookDeliveries: [], portalUsers: [], portalSessions: [], carriers: [], carrierSettlements: [] };
}
