/** Options shared by the company wizard (browser) and its validation (server). */
export const PLAN_TIERS = ['Piloto', 'Estándar', 'Profesional', 'Corporativo'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export const RETENTION_DAYS = [15, 30, 45, 60, 90] as const;

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;
