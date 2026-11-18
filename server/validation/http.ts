import type { Request, Response } from 'express';
import type { z } from 'zod';
import { idParam } from './schemas.ts';

function formatIssue(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? issue.path.join('.') : 'cuerpo';
  if (issue.code === 'invalid_type') return `${field}: tipo inválido`;
  if (issue.code === 'invalid_value') return `${field}: valor no permitido`;
  if (issue.code === 'too_big') return `${field}: excede el máximo permitido`;
  if (issue.code === 'too_small') return `${field}: ${issue.message.startsWith('Too') ? 'valor demasiado pequeño' : issue.message}`;
  if (issue.code === 'unrecognized_keys') return `${field}: campos no permitidos (${issue.keys.join(', ')})`;
  return `${field}: ${issue.message}`;
}

/** Parses req.body or answers 400 with the first issue in Spanish. Returns null when it already responded. */
export function parseBody<S extends z.ZodType>(schema: S, req: Request, res: Response): z.output<S> | null {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    res.status(400).json({ error: `Datos inválidos. ${formatIssue(result.error.issues[0])}` });
    return null;
  }
  return result.data;
}

/** Validates the `:id` route param. */
export function parseId(req: Request, res: Response): string | null {
  const result = idParam.safeParse(req.params.id);
  if (!result.success) {
    res.status(400).json({ error: 'Identificador inválido.' });
    return null;
  }
  return result.data;
}
