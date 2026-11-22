/**
 * CUIT (Argentina): 11 digits, XX-XXXXXXXX-X.
 * Check digit (módulo 11) with weights 5,4,3,2,7,6,5,4,3,2:
 *   result = 11 - (sum mod 11); 11 → 0; 10 → invalid.
 */

const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const PREFIXES = new Set(['20', '23', '24', '27', '30', '33', '34']);

export function normalizeCuit(value: string): string {
  return value.replace(/\D/g, '');
}

export function cuitCheckDigit(first10: string): number | null {
  if (!/^\d{10}$/.test(first10)) return null;
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * Number(first10[i]), 0);
  const result = 11 - (sum % 11);
  if (result === 11) return 0;
  if (result === 10) return null;
  return result;
}

export type CuitProblem = 'longitud' | 'prefijo' | 'digito_verificador';

/** Returns null when valid, or what is wrong (for a precise message). */
export function cuitProblem(value: string): CuitProblem | null {
  const digits = normalizeCuit(value);
  if (digits.length !== 11) return 'longitud';
  if (!PREFIXES.has(digits.slice(0, 2))) return 'prefijo';
  if (cuitCheckDigit(digits.slice(0, 10)) !== Number(digits[10])) return 'digito_verificador';
  return null;
}

export function isValidCuit(value: string): boolean {
  return cuitProblem(value) === null;
}

export const CUIT_MESSAGES: Record<CuitProblem, string> = {
  longitud: 'El CUIT debe tener 11 dígitos.',
  prefijo: 'El CUIT debe empezar con 20, 23, 24, 27, 30, 33 o 34.',
  digito_verificador: 'El CUIT no es válido: revisa los dígitos (el verificador no coincide).',
};

/** "30712345678" → "30-71234567-8" (assumes 11 digits). */
export function formatCuit(value: string): string {
  const d = normalizeCuit(value);
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : value;
}

/** Key used to detect duplicates regardless of dashes or case (also matches legacy RFC ids). */
export function taxIdKey(value: string): string {
  return value.replace(/-/g, '').toUpperCase();
}
