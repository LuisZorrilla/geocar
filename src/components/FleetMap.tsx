import { useEffect, useMemo, useRef, useState } from 'react';
import ArcGISMap from '@arcgis/core/Map.js';
import MapView from '@arcgis/core/views/MapView.js';
import Basemap from '@arcgis/core/Basemap.js';
import TileLayer from '@arcgis/core/layers/TileLayer.js';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer.js';
import Graphic from '@arcgis/core/Graphic.js';
import Point from '@arcgis/core/geometry/Point.js';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol.js';
import TextSymbol from '@arcgis/core/symbols/TextSymbol.js';
import { Compass, Layers, LocateFixed, ZoomIn, ZoomOut } from 'lucide-react';
import type { Vehicle } from '../shared/types.ts';
import { ASSET_TYPE_LABELS, STATUS_META } from '../lib/api.ts';

export type MapBasemapMode = 'dark-gray-canvas' | 'imagery' | 'gis';

interface FleetMapProps {
  vehicles: Vehicle[];
  selectedVehicleId: string | null;
  onSelectVehicle: (vehicleId: string) => void;
}

function detectWebGLSupport(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

function createArcGISBasemap(mode: 'dark-gray-canvas' | 'imagery'): Basemap {
  if (mode === 'imagery') {
    return new Basemap({
      id: 'esri-imagery-keyless',
      title: 'Imagery',
      baseLayers: [
        new TileLayer({
          url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        }),
      ],
      referenceLayers: [
        new TileLayer({
          url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer',
          opacity: 0.78,
        }),
      ],
    });
  }

  return new Basemap({
    id: 'esri-dark-gray-canvas-keyless',
    title: 'Dark Gray Canvas',
    baseLayers: [
      new TileLayer({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer',
      }),
    ],
    referenceLayers: [
      new TileLayer({
        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer',
      }),
    ],
  });
}

const REFERENCE_HUBS = [
  { name: 'Monterrey', lat: 25.6866, lng: -100.3161 },
  { name: 'Saltillo', lat: 25.4232, lng: -100.9924 },
  { name: 'León', lat: 21.125, lng: -101.686 },
  { name: 'Guadalajara', lat: 20.6597, lng: -103.3496 },
  { name: 'Querétaro', lat: 20.5888, lng: -100.3899 },
  { name: 'CDMX', lat: 19.4326, lng: -99.1332 },
];

export function FleetMap({ vehicles, selectedVehicleId, onSelectVehicle }: FleetMapProps) {
  const webglAvailable = useMemo(() => detectWebGLSupport(), []);
  const [mapMode, setMapMode] = useState<MapBasemapMode>(webglAvailable ? 'dark-gray-canvas' : 'gis');
  const [mapError, setMapError] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<ArcGISMap | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const graphicsLayerRef = useRef<GraphicsLayer | null>(null);
  const onSelectVehicleRef = useRef(onSelectVehicle);

  useEffect(() => {
    onSelectVehicleRef.current = onSelectVehicle;
  }, [onSelectVehicle]);

  const initialCenter = useMemo(() => {
    if (vehicles.length === 0) return { lat: 22.3, lng: -100.8 };
    const avgLat = vehicles.reduce((acc, v) => acc + v.lat, 0) / vehicles.length;
    const avgLng = vehicles.reduce((acc, v) => acc + v.lng, 0) / vehicles.length;
    return { lat: avgLat, lng: avgLng };
  }, [vehicles.length]);

  const [gisZoom, setGisZoom] = useState(1.25);
  const [gisCenter, setGisCenter] = useState<{ lat: number; lng: number }>(initialCenter);

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.id === selectedVehicleId) ?? null,
    [vehicles, selectedVehicleId]
  );

  // Initialize @arcgis/core Map + MapView with keyless Esri layers
  useEffect(() => {
    if (mapMode === 'gis' || !mapContainerRef.current) return;

    let disposed = false;

    try {
      const graphicsLayer = new GraphicsLayer({ id: 'fleet-units-layer' });
      const arcgisMap = new ArcGISMap({
        basemap: createArcGISBasemap(mapMode),
        layers: [graphicsLayer],
      });

      const view = new MapView({
        container: mapContainerRef.current,
        map: arcgisMap,
        center: [initialCenter.lng, initialCenter.lat],
        zoom: 6,
        ui: { components: [] },
        constraints: { minZoom: 3, maxZoom: 19 },
        popupEnabled: false,
      });

      const clickHandle = view.on('click', async (event) => {
        if (disposed) return;
        try {
          const hit = await view.hitTest(event, { include: graphicsLayer });
          const match = hit.results.find(
            (r) => r.type === 'graphic' && r.graphic?.attributes && typeof r.graphic.attributes.vehicleId === 'string'
          );
          if (match && match.type === 'graphic') {
            onSelectVehicleRef.current(match.graphic.attributes.vehicleId as string);
          }
        } catch {
          // Ignore hitTest cancellation
        }
      });

      const moveHandle = view.on('pointer-move', async (event) => {
        if (disposed || !mapContainerRef.current) return;
        try {
          const hit = await view.hitTest(event, { include: graphicsLayer });
          const hasUnit = hit.results.some(
            (r) => r.type === 'graphic' && typeof r.graphic?.attributes?.vehicleId === 'string'
          );
          mapContainerRef.current.style.cursor = hasUnit ? 'pointer' : 'grab';
        } catch {
          // Ignore hover test cancellation
        }
      });

      view.when(
        () => {
          if (!disposed) setMapError(false);
        },
        () => {
          if (!disposed) {
            setMapError(true);
            setMapMode('gis');
          }
        }
      );

      mapRef.current = arcgisMap;
      viewRef.current = view;
      graphicsLayerRef.current = graphicsLayer;

      return () => {
        disposed = true;
        clickHandle.remove();
        moveHandle.remove();
        view.destroy();
        viewRef.current = null;
        mapRef.current = null;
        graphicsLayerRef.current = null;
      };
    } catch {
      setMapError(true);
      setMapMode('gis');
      return undefined;
    }
    // Only recreate MapView when switching in/out of GIS fallback or tenant initial center changes
  }, [mapMode === 'gis', initialCenter.lat, initialCenter.lng]);

  // Swap ArcGIS basemap seamlessly between 'Dark Gray Canvas' and 'Imagery' without recreating MapView
  useEffect(() => {
    if (mapMode === 'gis' || !mapRef.current) return;
    mapRef.current.basemap = createArcGISBasemap(mapMode);
  }, [mapMode]);

  // Sync fleet unit graphics on ArcGIS GraphicsLayer
  useEffect(() => {
    const layer = graphicsLayerRef.current;
    if (!layer || mapMode === 'gis') return;

    const graphics: Graphic[] = [];

    for (const v of vehicles) {
      const isSelected = v.id === selectedVehicleId;
      const meta = STATUS_META[v.operationalStatus];
      const isHeavy = v.assetType === 'maquinaria_pesada';
      const point = new Point({ longitude: v.lng, latitude: v.lat });

      if (isSelected) {
        graphics.push(
          new Graphic({
            geometry: point,
            attributes: { vehicleId: v.id },
            symbol: new SimpleMarkerSymbol({
              style: 'circle',
              size: 24,
              color: [56, 189, 248, 0.22],
              outline: { color: '#38BDF8', width: 1.5 },
            }),
          })
        );
      }

      graphics.push(
        new Graphic({
          geometry: point,
          attributes: { vehicleId: v.id },
          symbol: new SimpleMarkerSymbol({
            style: isHeavy ? 'square' : 'circle',
            size: isSelected ? 14 : 10,
            color: meta.dotHex,
            outline: {
              color: isSelected ? '#F8FAFC' : '#0B1120',
              width: isSelected ? 2 : 1.5,
            },
          }),
        })
      );

      if (isSelected) {
        graphics.push(
          new Graphic({
            geometry: point,
            attributes: { vehicleId: v.id },
            symbol: new TextSymbol({
              text: `${v.unitCode} · ${isHeavy ? `${v.engineHours}h` : `${v.speedKmh} km/h`}`,
              color: '#F8FAFC',
              haloColor: '#0F172A',
              haloSize: 2,
              yoffset: 16,
              font: {
                size: 10,
                family: 'JetBrains Mono, monospace',
                weight: 'bold',
              },
            }),
          })
        );
      }
    }

    layer.removeAll();
    layer.addMany(graphics);
  }, [vehicles, selectedVehicleId, mapMode]);

  // Smoothly focus selected unit (zooms closer in 'Imagery' for heavy machinery inspection)
  useEffect(() => {
    if (!selectedVehicle) return;
    if (mapMode !== 'gis' && viewRef.current) {
      const view = viewRef.current;
      const targetZoom =
        mapMode === 'imagery'
          ? Math.max(view.zoom || 6, selectedVehicle.assetType === 'maquinaria_pesada' ? 16 : 14)
          : Math.max(view.zoom || 6, 11);
      view
        .goTo(
          {
            center: [selectedVehicle.lng, selectedVehicle.lat],
            zoom: targetZoom,
          },
          { duration: 550 }
        )
        .catch(() => {
          // Ignore interrupted goTo animations
        });
    } else if (mapMode === 'gis') {
      setGisCenter({ lat: selectedVehicle.lat, lng: selectedVehicle.lng });
    }
  }, [selectedVehicle?.id, mapMode]);

  const handleZoomIn = () => {
    if (mapMode !== 'gis' && viewRef.current) {
      viewRef.current.goTo({ zoom: Math.min(19, (viewRef.current.zoom || 6) + 1) }, { duration: 250 }).catch(() => {});
    } else {
      setGisZoom((z) => Math.min(4, Number((z * 1.35).toFixed(2))));
    }
  };

  const handleZoomOut = () => {
    if (mapMode !== 'gis' && viewRef.current) {
      viewRef.current.goTo({ zoom: Math.max(3, (viewRef.current.zoom || 6) - 1) }, { duration: 250 }).catch(() => {});
    } else {
      setGisZoom((z) => Math.max(0.6, Number((z / 1.35).toFixed(2))));
    }
  };

  const handleRecenter = () => {
    if (mapMode !== 'gis' && viewRef.current) {
      viewRef.current.goTo({ center: [initialCenter.lng, initialCenter.lat], zoom: 6 }, { duration: 500 }).catch(() => {});
    } else {
      setGisCenter(initialCenter);
      setGisZoom(1.25);
    }
  };

  const projectPoint = (lat: number, lng: number) => {
    const spanLng = 9.0 / gisZoom;
    const spanLat = 8.4 / gisZoom;
    const x = ((lng - (gisCenter.lng - spanLng / 2)) / spanLng) * 1000;
    const y = ((gisCenter.lat + spanLat / 2 - lat) / spanLat) * 600;
    return { x, y };
  };

  return (
    <div className="relative w-full h-full min-h-[480px] bg-[#070D19] rounded-xl border border-slate-800/90 overflow-hidden">
      {mapMode !== 'gis' && <div ref={mapContainerRef} className="w-full h-full" />}

      {(mapMode === 'gis' || mapError) && (
        <svg
          viewBox="0 0 1000 600"
          preserveAspectRatio="xMidYMid slice"
          className="w-full h-full select-none bg-[#070D19]"
          role="img"
          aria-label="Mapa GIS táctico de flota"
        >
          <defs>
            <pattern id="gis-grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(148,163,184,0.07)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="1000" height="600" fill="url(#gis-grid)" />

          <g stroke="rgba(56, 189, 248, 0.16)" strokeWidth="2" fill="none" strokeDasharray="6 4">
            {(() => {
              const pts = REFERENCE_HUBS.map((h) => projectPoint(h.lat, h.lng));
              return (
                <>
                  <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} />
                  <line x1={pts[1].x} y1={pts[1].y} x2={pts[4].x} y2={pts[4].y} />
                  <line x1={pts[4].x} y1={pts[4].y} x2={pts[5].x} y2={pts[5].y} />
                  <line x1={pts[4].x} y1={pts[4].y} x2={pts[2].x} y2={pts[2].y} />
                  <line x1={pts[2].x} y1={pts[2].y} x2={pts[3].x} y2={pts[3].y} />
                </>
              );
            })()}
          </g>

          {REFERENCE_HUBS.map((hub) => {
            const p = projectPoint(hub.lat, hub.lng);
            return (
              <g key={hub.name} transform={`translate(${p.x}, ${p.y})`}>
                <circle r={24 * Math.min(gisZoom, 2.2)} fill="rgba(2, 132, 199, 0.06)" stroke="rgba(56, 189, 248, 0.25)" strokeWidth="1" />
                <text
                  x="0"
                  y={-28 * Math.min(gisZoom, 2.2)}
                  textAnchor="middle"
                  fill="#64748B"
                  fontSize="11"
                  fontFamily="Plus Jakarta Sans, sans-serif"
                  fontWeight="600"
                >
                  {hub.name}
                </text>
              </g>
            );
          })}

          {vehicles.map((v) => {
            const p = projectPoint(v.lat, v.lng);
            if (p.x < -30 || p.x > 1030 || p.y < -30 || p.y > 630) return null;
            const isSelected = v.id === selectedVehicleId;
            const meta = STATUS_META[v.operationalStatus];
            const isHeavy = v.assetType === 'maquinaria_pesada';
            return (
              <g
                key={v.id}
                transform={`translate(${p.x}, ${p.y})`}
                onClick={() => onSelectVehicle(v.id)}
                className="cursor-pointer"
              >
                {isSelected && (
                  <circle r="15" fill="rgba(56, 189, 248, 0.22)" stroke="#38BDF8" strokeWidth="1.5" />
                )}
                {isHeavy ? (
                  <rect
                    x={isSelected ? -6 : -4.5}
                    y={isSelected ? -6 : -4.5}
                    width={isSelected ? 12 : 9}
                    height={isSelected ? 12 : 9}
                    rx="2"
                    fill={meta.dotHex}
                    stroke="#0B1120"
                    strokeWidth="1.5"
                  />
                ) : (
                  <circle r={isSelected ? 6.5 : 4.5} fill={meta.dotHex} stroke="#0B1120" strokeWidth="1.5" />
                )}
                {isSelected && (
                  <g transform="translate(0, -18)">
                    <rect x="-52" y="-14" width="104" height="18" rx="4" fill="#0F172A" stroke="#38BDF8" strokeWidth="1" />
                    <text
                      x="0"
                      y="-2"
                      textAnchor="middle"
                      fill="#F8FAFC"
                      fontSize="10"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {v.unitCode} · {isHeavy ? `${v.engineHours}h` : `${v.speedKmh} km/h`}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
      )}

      {/* Top-left Legend */}
      <div className="absolute top-3 left-3 flex flex-wrap items-center gap-3 bg-[#0F172A]/90 backdrop-blur-sm border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-300">
        <span className="font-medium text-slate-200">
          {mapMode === 'imagery'
            ? 'ArcGIS · Imagery'
            : mapMode === 'dark-gray-canvas'
              ? 'ArcGIS · Dark Gray Canvas'
              : 'Vector GIS'}
        </span>
        <span className="text-slate-600">·</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[#22C55E]" /> Operando
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[#94A3B8]" /> Detenido
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-[#EF4444]" /> Alerta
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[2px] border border-slate-300 inline-block" /> Maquinaria
        </span>
      </div>

      {/* Top-right ArcGIS Layer & Zoom Controls */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        {webglAvailable && (
          <div className="flex items-center bg-[#0F172A]/90 border border-slate-800 rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onClick={() => {
                setMapError(false);
                setMapMode('dark-gray-canvas');
              }}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition-colors whitespace-nowrap ${
                mapMode === 'dark-gray-canvas'
                  ? 'bg-sky-600 text-white font-medium'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Dark Gray Canvas
            </button>
            <button
              type="button"
              onClick={() => {
                setMapError(false);
                setMapMode('imagery');
              }}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition-colors whitespace-nowrap ${
                mapMode === 'imagery' ? 'bg-sky-600 text-white font-medium' : 'text-slate-300 hover:text-white'
              }`}
            >
              Imagery
            </button>
            <button
              type="button"
              onClick={() => setMapMode('gis')}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md cursor-pointer transition-colors whitespace-nowrap ${
                mapMode === 'gis' ? 'bg-sky-600 text-white font-medium' : 'text-slate-300 hover:text-white'
              }`}
            >
              <Layers className="w-3 h-3" /> GIS
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={handleZoomIn}
          className="p-1.5 rounded-lg bg-[#0F172A]/90 border border-slate-800 text-slate-200 hover:bg-slate-800/90 transition-colors cursor-pointer"
          aria-label="Acercar mapa"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleZoomOut}
          className="p-1.5 rounded-lg bg-[#0F172A]/90 border border-slate-800 text-slate-200 hover:bg-slate-800/90 transition-colors cursor-pointer"
          aria-label="Alejar mapa"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleRecenter}
          className="p-1.5 rounded-lg bg-[#0F172A]/90 border border-slate-800 text-slate-200 hover:bg-slate-800/90 transition-colors cursor-pointer"
          aria-label="Centrar flota"
          title="Centrar flota"
        >
          <LocateFixed className="w-4 h-4" />
        </button>
      </div>

      {/* Bottom Selected Unit Coordinates + Esri ArcGIS Attribution */}
      <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        {selectedVehicle ? (
          <div className="pointer-events-auto bg-[#0F172A]/92 backdrop-blur-sm border border-slate-800 rounded-lg px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-semibold text-slate-100">{selectedVehicle.unitCode}</span>
            <span className="text-sky-300">{ASSET_TYPE_LABELS[selectedVehicle.assetType]}</span>
            <span className="font-mono tabular-nums text-slate-300">
              {selectedVehicle.lat.toFixed(5)}, {selectedVehicle.lng.toFixed(5)}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-slate-300">
              <Compass className="w-3.5 h-3.5 text-slate-400" />
              {selectedVehicle.engineHours} h · {selectedVehicle.speedKmh} km/h
            </span>
          </div>
        ) : (
          <div />
        )}

        {mapMode !== 'gis' && (
          <div className="pointer-events-auto bg-[#0B1120]/85 border border-slate-800/80 rounded px-2 py-0.5 text-[10px] text-slate-400">
            {mapMode === 'imagery'
              ? 'ArcGIS Maps SDK · Esri, Maxar, Earthstar Geographics, GIS User Community'
              : 'ArcGIS Maps SDK · Esri, HERE, Garmin, OpenStreetMap, GIS User Community'}
          </div>
        )}
      </div>
    </div>
  );
}
