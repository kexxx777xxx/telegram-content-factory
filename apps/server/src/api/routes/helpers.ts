import type { Response } from 'express';
import type { z } from 'zod';

/** Turns a zod failure into the one sentence the operator needs. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Некоректні дані';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

export function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}
