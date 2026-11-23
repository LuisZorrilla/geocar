/** Geographic helpers shared by server and browser. */

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in meters (haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const isValidLatLng = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' &&
  typeof lng === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

/** "1,2 km" / "350 m". */
export const formatDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`);

/**
 * Ring of a circle of `radiusM` around a point, as [lng, lat] pairs (closed). Used to draw
 * geofences as plain polygons in WGS84.
 */
export function circleRing(center: { lat: number; lng: number }, radiusM: number, points = 64): Array<[number, number]> {
  const lat1 = rad(center.lat);
  const lng1 = rad(center.lng);
  const d = radiusM / EARTH_RADIUS_M;
  const ring: Array<[number, number]> = [];
  for (let i = 0; i <= points; i++) {
    const brng = (2 * Math.PI * i) / points;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}
