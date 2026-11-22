import type { DeviceUplink, ProtocolType } from './types.ts';

/**
 * Catalog of GPS / dashcam equipment the panel knows how to provision.
 * Source: docs/dashcams-compatibles-starlink-jt808-v2.pdf (compatibility with the
 * Starlink → VPS → Traccar (JT/T 808 + JT/T 1078) architecture).
 *
 * Each model points to a driver profile (DashcamDriverProfile.id) that supplies the
 * default dashcam configuration; the server never guesses it from free text when a
 * catalog model is chosen.
 */

/** How well the model fits the architecture: alta = confirmed, media = declared, baja = proprietary protocol. */
export type DeviceCompatibility = 'alta' | 'media' | 'baja';

export interface DeviceCatalogModel {
  id: string;
  vendor: string;
  model: string;
  kind: 'Dashcam' | 'Dashcam IA' | 'MDVR' | 'MDVR IA' | 'NVR móvil' | 'GPS + CAN';
  protocol: ProtocolType;
  driverId: string;
  channels: string;
  /** Ways the device can reach the server, preferred first. */
  uplinks: DeviceUplink[];
  compatibility: DeviceCompatibility;
  note: string;
}

export const GENERIC_JT808_DRIVER_ID = 'drv-jt808-generic';

export const DEVICE_CATALOG: DeviceCatalogModel[] = [
  // ---- Jimi IoT (Concox): confirmed with Traccar 5015 + 5263 -----------------------------------
  {
    id: 'jimi-jc181', vendor: 'Jimi IoT', model: 'JC181', kind: 'Dashcam', protocol: 'JT808/JT1078', driverId: 'drv-jimi-jc181',
    channels: '2 integradas (frontal 1080p + cabina)', uplinks: ['celular'], compatibility: 'alta',
    note: 'Probada en Traccar (5015 + 5263). Sale por 4G: necesita chip con datos; WiFi cliente no confirmado.',
  },
  {
    id: 'jimi-jc261', vendor: 'Jimi IoT', model: 'JC261', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: 'drv-jimi-jc181',
    channels: 'Frontal 1080p + cabina opcional', uplinks: ['wifi_starlink', 'celular'], compatibility: 'alta',
    note: 'ADAS. Declara WiFi 2,4 GHz en modo cliente (STA): verificar que el enlace JT808 salga por WiFi sin chip.',
  },
  {
    id: 'jimi-jc261p', vendor: 'Jimi IoT', model: 'JC261P', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: 'drv-jimi-jc181',
    channels: 'Frontal 1080p + cabina 720p incluida', uplinks: ['wifi_starlink', 'celular'], compatibility: 'alta',
    note: 'Igual a la JC261 con cámara de cabina incluida. WiFi cliente a verificar.',
  },
  {
    id: 'jimi-jc400p', vendor: 'Jimi IoT', model: 'JC400P', kind: 'Dashcam', protocol: 'JT808/JT1078', driverId: 'drv-jimi-jc400',
    channels: 'Frontal + cabina externa opcional', uplinks: ['celular', 'wifi_starlink'], compatibility: 'media',
    note: 'JT808/1078 listados por Jimi; video en Traccar no confirmado.',
  },
  {
    id: 'jimi-jc400d', vendor: 'Jimi IoT', model: 'JC400D', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: 'drv-jimi-jc400',
    channels: '2 canales (frontal + cabina)', uplinks: ['celular', 'wifi_starlink'], compatibility: 'media',
    note: 'DMS (ojos cerrados, distracción, teléfono). JT808/1078 listados por Jimi.',
  },
  {
    id: 'jimi-jc450', vendor: 'Jimi IoT', model: 'JC450 Pro', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: 'drv-jimi-jc400',
    channels: '4 canales', uplinks: ['celular'], compatibility: 'media',
    note: 'Dashcam 4 canales LTE. JT808/1078 listados por Jimi.',
  },
  // ---- Meitrack -----------------------------------------------------------------------------------
  {
    id: 'meitrack-md300', vendor: 'Meitrack', model: 'MD300', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: GENERIC_JT808_DRIVER_ID,
    channels: '4 (2 integradas + 2 AHD)', uplinks: ['celular'], compatibility: 'media', note: 'JT808/1078 en documento oficial de Meitrack.',
  },
  {
    id: 'meitrack-md600', vendor: 'Meitrack', model: 'MD600', kind: 'MDVR IA', protocol: 'JT808/JT1078', driverId: GENERIC_JT808_DRIVER_ID,
    channels: '6 canales 1080p, SSD', uplinks: ['wifi_starlink', 'celular'], compatibility: 'media', note: '4G + WiFi + Bluetooth. JT808/1078 oficial.',
  },
  {
    id: 'meitrack-md833h', vendor: 'Meitrack', model: 'MD833H', kind: 'MDVR', protocol: 'JT808/JT1078', driverId: GENERIC_JT808_DRIVER_ID,
    channels: 'n/d', uplinks: ['wifi_starlink', 'celular'], compatibility: 'media', note: '4G + WiFi. JT808/1078 oficial.',
  },
  // ---- MettaX ------------------------------------------------------------------------------------
  {
    id: 'mettax-mc403', vendor: 'MettaX', model: 'MC403', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: GENERIC_JT808_DRIVER_ID,
    channels: '1 integrada + 3 externas', uplinks: ['celular'], compatibility: 'media', note: 'ADAS/DMS. JT808/1078 confirmados por integradores.',
  },
  {
    id: 'mettax-mc908', vendor: 'MettaX', model: 'MC908', kind: 'MDVR IA', protocol: 'JT808/JT1078', driverId: GENERIC_JT808_DRIVER_ID,
    channels: 'Hasta 8 canales 1080p', uplinks: ['celular'], compatibility: 'media', note: 'Alimentación 9–36 V. JT808/1078 por integradores.',
  },
  // ---- Dahua / Hikvision mobile ------------------------------------------------------------------
  {
    id: 'dahua-mxvr4104', vendor: 'Dahua', model: 'MXVR4104-GFWI', kind: 'MDVR IA', protocol: 'JT808/JT1078', driverId: 'drv-hik-dahua-mdvr',
    channels: '4 analógicas + 4 IP', uplinks: ['wifi_starlink', 'celular'], compatibility: 'media', note: 'JT808 seleccionable; JT1078 sin confirmar.',
  },
  {
    id: 'dahua-mnvr4208', vendor: 'Dahua', model: 'MNVR4208-GFWI', kind: 'NVR móvil', protocol: 'JT808/JT1078', driverId: 'drv-hik-dahua-mdvr',
    channels: '8 IP PoE', uplinks: ['wifi_starlink', 'celular'], compatibility: 'media', note: 'JT808 seleccionable; JT1078 sin confirmar.',
  },
  {
    id: 'dahua-mxvr1004', vendor: 'Dahua', model: 'MXVR1004-GFWI', kind: 'MDVR', protocol: 'JT808/JT1078', driverId: 'drv-hik-dahua-mdvr',
    channels: '4 canales', uplinks: ['wifi_starlink', 'celular'], compatibility: 'media', note: 'JT808 seleccionable; JT1078 sin confirmar.',
  },
  {
    id: 'hik-ae-di5042', vendor: 'Hikvision', model: 'AE-DI5042-G4', kind: 'Dashcam', protocol: 'JT808/JT1078', driverId: 'drv-hik-dahua-mdvr',
    channels: '1 (1440p)', uplinks: ['celular'], compatibility: 'media', note: 'JT808 variante «Jiangsu»; JT1078 sin confirmar.',
  },
  {
    id: 'hik-ae-md5043', vendor: 'Hikvision', model: 'AE-MD5043', kind: 'MDVR', protocol: 'JT808/JT1078', driverId: 'drv-hik-dahua-mdvr',
    channels: '4 canales', uplinks: ['celular'], compatibility: 'media', note: 'Soporte JT808/1078 sin confirmar.',
  },
  {
    id: 'hik-ds-mp5604', vendor: 'Hikvision', model: 'DS-MP5604', kind: 'MDVR', protocol: 'JT808/JT1078', driverId: 'drv-hik-dahua-mdvr',
    channels: '4 canales AHD', uplinks: ['celular'], compatibility: 'media', note: 'MDVR de la flota demo.',
  },
  // ---- Proprietary protocol (low fit) ------------------------------------------------------------
  {
    id: 'howen-me40', vendor: 'Howen', model: 'Hero-ME40-04', kind: 'MDVR', protocol: 'JT808/JT1078', driverId: 'drv-howen-me40',
    channels: '4 canales', uplinks: ['celular'], compatibility: 'baja', note: 'Usa protocolo propio de Howen: no conecta a Traccar por JT808.',
  },
  {
    id: 'howen-me41', vendor: 'Howen', model: 'Hero-ME41-02', kind: 'Dashcam', protocol: 'JT808/JT1078', driverId: 'drv-howen-me40',
    channels: '2 canales 1080p', uplinks: ['celular'], compatibility: 'baja', note: 'Protocolo propio de Howen.',
  },
  {
    id: 'streamax-x3', vendor: 'Streamax', model: 'X3-H0402', kind: 'MDVR', protocol: 'JT808/JT1078', driverId: 'drv-streamax-x3',
    channels: '4 canales', uplinks: ['celular', 'wifi_starlink'], compatibility: 'baja', note: 'Protocolo propio de Streamax (CEIBA).',
  },
  {
    id: 'streamax-c6d', vendor: 'Streamax', model: 'C6D', kind: 'Dashcam IA', protocol: 'JT808/JT1078', driverId: 'drv-streamax-x3',
    channels: '2 canales', uplinks: ['celular'], compatibility: 'baja', note: 'Protocolo propio de Streamax (CEIBA).',
  },
  // ---- Traccar native (GPS + CAN) ----------------------------------------------------------------
  {
    id: 'teltonika-fmc130', vendor: 'Teltonika', model: 'FMC130', kind: 'GPS + CAN', protocol: 'Traccar', driverId: 'drv-teltonika-fmc',
    channels: 'GPS + DualCam opcional', uplinks: ['celular'], compatibility: 'alta', note: 'Protocolo Teltonika nativo en Traccar (puerto 5027).',
  },
  {
    id: 'teltonika-fmc650', vendor: 'Teltonika', model: 'FMC650', kind: 'GPS + CAN', protocol: 'Traccar', driverId: 'drv-teltonika-fmc',
    channels: 'GPS + CAN FMS/J1939 + DualCam opcional', uplinks: ['celular'], compatibility: 'alta', note: 'Lectura de bus CAN de camiones y maquinaria.',
  },
  {
    id: 'teltonika-fmc003', vendor: 'Teltonika', model: 'FMC003', kind: 'GPS + CAN', protocol: 'Traccar', driverId: 'drv-teltonika-fmc',
    channels: 'GPS + OBD-II', uplinks: ['celular'], compatibility: 'alta', note: 'Se conecta al puerto OBD-II de vehículos livianos.',
  },
];

export const UPLINK_LABELS: Record<DeviceUplink, string> = {
  wifi_starlink: 'WiFi → Starlink',
  ethernet_starlink: 'Ethernet → Starlink',
  celular: 'Celular (SIM)',
};

export const COMPATIBILITY_LABELS: Record<DeviceCompatibility, string> = {
  alta: 'Compatible confirmada',
  media: 'Compatible a verificar',
  baja: 'Protocolo propio',
};

export function findCatalogModel(id: string | undefined): DeviceCatalogModel | undefined {
  return id ? DEVICE_CATALOG.find((m) => m.id === id) : undefined;
}

export const catalogModelLabel = (m: DeviceCatalogModel) => `${m.vendor} ${m.model}`;
