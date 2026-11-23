import { useEffect, useMemo, useRef, useState } from 'react';
import ArcGISMap from '@arcgis/core/Map.js';
import MapView from '@arcgis/core/views/MapView.js';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js';
import Graphic from '@arcgis/core/Graphic.js';
import { MAP_REGION } from '../../shared/region.ts';
import { circleRing } from '../../shared/geo.ts';
import { createArcGISBasemap, detectWebGLSupport } from '../FleetMap.tsx';

export interface MapCircle {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
  label?: string;
  /** done = green, current = amber, default = sky. */
  tone?: 'default' | 'current' | 'done';
}

const TONES = {
  default: { fill: [56, 189, 248, 0.16], line: [56, 189, 248, 0.9] },
  current: { fill: [251, 191, 36, 0.2], line: [251, 191, 36, 0.95] },
  done: { fill: [52, 211, 153, 0.14], line: [52, 211, 153, 0.85] },
} as const;

/**
 * Small ArcGIS map for the TMS: place geofences (circles), the unit's position and, when
 * `onPick` is given, choosing a location by clicking. Falls back to a notice without WebGL.
 */
export function TmsMap({
  circles,
  unit,
  path,
  onPick,
  height = 260,
  label = 'Mapa',
}: {
  circles: MapCircle[];
  /** Route to draw, as [lng, lat] pairs. */
  path?: Array<[number, number]> | null;
  unit?: { lat: number; lng: number; label: string } | null;
  onPick?: (lat: number, lng: number) => void;
  height?: number;
  label?: string;
}) {
  const webgl = useMemo(() => detectWebGLSupport(), []);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const layerRef = useRef<GraphicsLayer | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const center = useMemo(() => {
    const pts = [...circles, ...(unit ? [unit] : [])];
    if (pts.length === 0) return MAP_REGION.center;
    return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lng: pts.reduce((a, p) => a + p.lng, 0) / pts.length };
    // Only the first render's center: later changes are handled by goTo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!webgl || !containerRef.current) return;
    let disposed = false;
    const layer = new GraphicsLayer();
    const view = new MapView({
      container: containerRef.current,
      map: new ArcGISMap({ basemap: createArcGISBasemap('dark-gray-canvas'), layers: [layer] }),
      center: [center.lng, center.lat],
      zoom: circles.length ? 13 : MAP_REGION.zoom,
      ui: { components: ['zoom'] },
      constraints: { minZoom: 3, maxZoom: 19 },
      popupEnabled: false,
    });
    const click = view.on('click', (e) => {
      if (disposed || !onPickRef.current || !e.mapPoint) return;
      onPickRef.current(Number(e.mapPoint.latitude!.toFixed(6)), Number(e.mapPoint.longitude!.toFixed(6)));
    });
    view.when(undefined, () => !disposed && setFailed(true));
    viewRef.current = view;
    layerRef.current = layer;
    return () => {
      disposed = true;
      click.remove();
      view.destroy();
      viewRef.current = null;
      layerRef.current = null;
    };
  }, [webgl]);

  useEffect(() => {
    const layer = layerRef.current;
    const view = viewRef.current;
    if (!layer || !view) return;
    const graphics: Graphic[] = [];
    if (path && path.length >= 2) {
      graphics.push(
        new Graphic({
          geometry: { type: 'polyline', paths: [path], spatialReference: { wkid: 4326 } },
          symbol: { type: 'simple-line', color: [56, 189, 248, 0.9], width: 3 },
        })
      );
    }
    for (const c of circles) {
      const tone = TONES[c.tone ?? 'default'];
      graphics.push(
        new Graphic({
          // Plain objects: ArcGIS autocasts them with its own classes (no duplicate class copies).
          geometry: { type: 'polygon', rings: [circleRing(c, c.radiusM)], spatialReference: { wkid: 4326 } },
          symbol: { type: 'simple-fill', color: [...tone.fill], outline: { color: [...tone.line], width: 1.5 } },
        })
      );
      if (c.label) {
        graphics.push(
          new Graphic({
            geometry: { type: 'point', latitude: c.lat, longitude: c.lng },
            symbol: { type: 'text', text: c.label, color: '#F8FAFC', haloColor: '#0F172A', haloSize: 2, font: { size: 10, family: 'Noto Sans', weight: 'bold' } },
          })
        );
      }
    }
    if (unit) {
      graphics.push(
        new Graphic({
          geometry: { type: 'point', latitude: unit.lat, longitude: unit.lng },
          symbol: { type: 'simple-marker', style: 'circle', size: 12, color: [244, 63, 94, 1], outline: { color: [15, 23, 42, 1], width: 2 } },
        }),
        new Graphic({
          geometry: { type: 'point', latitude: unit.lat, longitude: unit.lng },
          symbol: { type: 'text', text: unit.label, yoffset: 14, color: '#F8FAFC', haloColor: '#0F172A', haloSize: 2, font: { size: 10, family: 'Ubuntu Mono', weight: 'bold' } },
        })
      );
    }
    layer.removeAll();
    layer.addMany(graphics);
    const targets = graphics.filter((g) => g.geometry);
    if (targets.length) view.goTo(targets.map((g) => g.geometry!), { animate: false }).catch(() => undefined);
  }, [circles, unit, path]);

  if (!webgl || failed) {
    return (
      <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-xs text-slate-400" style={{ minHeight: 80 }}>
        El mapa no está disponible en este navegador (sin WebGL). {onPick ? 'Cargá la latitud y longitud a mano.' : ''}
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      role="application"
      aria-label={label}
      className={`rounded-lg border border-slate-800 overflow-hidden ${onPick ? 'cursor-crosshair' : ''}`}
      style={{ height }}
    />
  );
}
