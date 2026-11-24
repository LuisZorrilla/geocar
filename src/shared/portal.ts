/**
 * TMS T5: customer portal (/portal). Users belong to one customer of one company and only see
 * that customer's orders, deliveries and invoices. Separate login and sessions from the panel.
 */

export interface PortalUser {
  id: string;
  tenantId: string;
  customerId: string;
  name: string;
  /** Login (unique across the platform, lowercase). */
  email: string;
  passwordHash: string;
  active: boolean;
  /** Temporary password given by the company: must be changed on first login. */
  mustChangePassword: boolean;
  failedLogins: number;
  lockedUntil?: string;
  lastLoginAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PortalSession {
  /** SHA-256 of the session token. */
  id: string;
  tenantId: string;
  portalUserId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface PortalMe {
  user: { id: string; name: string; email: string; mustChangePassword: boolean };
  customer: { id: string; name: string };
  company: { name: string };
}

export const PORTAL_SESSION_IDLE_H = 12;
export const PORTAL_SESSION_MAX_D = 7;
export const PORTAL_MAX_FAILED = 5;
export const PORTAL_LOCK_MIN = 15;
