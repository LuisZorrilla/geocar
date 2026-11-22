/**
 * Geographic region of the deployment: map framing, branch hubs and how far
 * demo units spread around each hub. Shared by the server seed and the map.
 * To move the platform to another city, change only this file and re-seed
 * the database (`npm run db:reset`, then `npm run dev`).
 */

export interface RegionHub {
  /** Locality shown on the map. */
  city: string;
  /** Branch name; tenants reference hubs through it. */
  branch: string;
  lat: number;
  lng: number;
  /** Operating geofence assigned to units of this hub. */
  geofence: string;
}

export interface MapRegion {
  name: string;
  center: { lat: number; lng: number };
  /** Initial ArcGIS zoom level (≈11 frames a metro area of ~60 km). */
  zoom: number;
  /** Degrees visible in the SVG fallback map at zoom 1. */
  gisSpan: { lat: number; lng: number };
  /** Seeded units are placed within ±spread/2 degrees of their hub. */
  unitSpreadDeg: number;
  hubs: RegionHub[];
}

export const MAP_REGION: MapRegion = {
  name: 'Gran San Juan, Argentina',
  center: { lat: -31.5650, lng: -68.4900 },
  zoom: 11,
  gisSpan: { lat: 0.42, lng: 0.62 },
  unitSpreadDeg: 0.06,
  hubs: [
    { city: 'San Juan Capital', branch: 'San Juan Capital', lat: -31.5375, lng: -68.5364, geofence: 'Microcentro Capital' },
    { city: 'Rawson', branch: 'Rawson', lat: -31.5770, lng: -68.5360, geofence: 'Villa Krause' },
    { city: 'Rivadavia', branch: 'Rivadavia', lat: -31.5290, lng: -68.5940, geofence: 'Av. Libertador Oeste' },
    { city: 'Chimbas', branch: 'Chimbas', lat: -31.4950, lng: -68.5300, geofence: 'Acceso Norte Chimbas' },
    { city: 'Pocito', branch: 'Pocito', lat: -31.6550, lng: -68.5800, geofence: 'Ruta 40 Sur Pocito' },
    { city: 'Caucete', branch: 'Caucete', lat: -31.6520, lng: -68.2810, geofence: 'Ruta 20 Caucete' },
  ],
};
