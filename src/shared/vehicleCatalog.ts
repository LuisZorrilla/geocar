import type { AssetType } from './types.ts';

export interface BrandEntry {
  brand: string;
  models: string[];
}

/**
 * Brands and models common in Argentine fleets. The form also accepts values that
 * are not listed, so this only has to cover the usual cases.
 */
export const VEHICLE_CATALOG: Record<AssetType, BrandEntry[]> = {
  vehiculo: [
    { brand: 'Toyota', models: ['Hilux', 'Hilux SRX', 'SW4', 'Hiace', 'Corolla', 'Corolla Cross', 'Etios', 'Yaris', 'Land Cruiser'] },
    { brand: 'Ford', models: ['Ranger', 'Ranger Raptor', 'Maverick', 'F-150', 'Transit', 'Territory', 'Cargo 1723', 'Cargo 1729', 'Cargo 1932'] },
    { brand: 'Volkswagen', models: ['Amarok', 'Saveiro', 'Taos', 'Gol Trend', 'Delivery 9.170', 'Delivery 11.180', 'Constellation 17.280', 'Constellation 24.280', 'Constellation 25.420', 'Meteor 28.460'] },
    { brand: 'Mercedes-Benz', models: ['Sprinter', 'Vito', 'Accelo 815', 'Accelo 1016', 'Atego 1419', 'Atego 1726', 'Atego 2426', 'Axor 2036', 'Axor 2041', 'Actros 2042', 'Actros 2546', 'Arocs 3342'] },
    { brand: 'Iveco', models: ['Daily 35-150', 'Daily 70-170', 'Tector 170E28', 'Tector 240E28', 'Hi-Road', 'Hi-Way 440', 'S-Way 480', 'Trakker 380'] },
    { brand: 'Scania', models: ['P 320', 'P 360', 'G 410', 'G 450', 'R 450', 'R 500', 'R 540', 'XT 450'] },
    { brand: 'Volvo', models: ['VM 270', 'VM 330', 'FM 380', 'FM 460', 'FH 460', 'FH 540', 'FMX 500'] },
    { brand: 'Renault', models: ['Kangoo', 'Master', 'Oroch', 'Alaskan', 'Duster'] },
    { brand: 'Chevrolet', models: ['S10', 'Montana', 'Tracker', 'Onix'] },
    { brand: 'Fiat', models: ['Strada', 'Toro', 'Fiorino', 'Ducato', 'Titano', 'Cronos'] },
    { brand: 'Peugeot', models: ['Partner', 'Expert', 'Boxer', '208', 'Landtrek'] },
    { brand: 'Nissan', models: ['Frontier', 'Kicks', 'NP300'] },
    { brand: 'Ram', models: ['700', '1000', '1500', '2500', 'Rampage'] },
    { brand: 'Agrale', models: ['8700', '10000', '14000', 'Marruá'] },
    { brand: 'Kenworth', models: ['T680', 'T880', 'T800'] },
  ],
  maquinaria_pesada: [
    { brand: 'Caterpillar', models: ['320 GC', '323', '336', '349', '416', '420', '950 GC', '966', '140 GC', '120', 'D6', 'D8T', '777', '785'] },
    { brand: 'Komatsu', models: ['PC200', 'PC210', 'PC360', 'PC490', 'WA320', 'WA380', 'WA470', 'D65', 'D155', 'GD555', 'HD465', 'HD785'] },
    { brand: 'John Deere', models: ['310L', '310SL', '544L', '624L', '670G', '672G', '850J', '210G', '350G'] },
    { brand: 'JCB', models: ['3CX', '4CX', 'JS220', '426ZX', '437ZX', '540-170'] },
    { brand: 'Volvo CE', models: ['EC200', 'EC220', 'EC380', 'L60', 'L90', 'L120', 'L150', 'A30G', 'A40G', 'G940'] },
    { brand: 'New Holland', models: ['B95', 'B110', 'W130', 'W190', 'RG140', 'E215'] },
    { brand: 'Case', models: ['580N', '580SN', '821F', '845B', 'CX220', '1650M'] },
    { brand: 'Hyundai', models: ['R220', 'HX220', 'HL960', 'HL757'] },
    { brand: 'XCMG', models: ['XE215', 'XE370', 'LW500', 'ZL50', 'GR180'] },
    { brand: 'SANY', models: ['SY215', 'SY365', 'SY500', 'STC250'] },
    { brand: 'Bobcat', models: ['S510', 'S650', 'S770', 'T770', 'E35'] },
    { brand: 'Liebherr', models: ['R 926', 'R 956', 'L 566', 'PR 736'] },
  ],
};

export function brandsFor(assetType: AssetType): string[] {
  return VEHICLE_CATALOG[assetType].map((b) => b.brand);
}

/** Models of a brand for the asset type (case-insensitive brand match); empty for an unknown brand. */
export function modelsFor(assetType: AssetType, brand: string): string[] {
  const key = brand.trim().toLowerCase();
  return VEHICLE_CATALOG[assetType].find((b) => b.brand.toLowerCase() === key)?.models ?? [];
}

export function composeBrandModel(brand: string, model: string): string {
  return [brand.trim(), model.trim()].filter(Boolean).join(' ');
}
