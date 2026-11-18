import { z } from 'zod';
import { isoDate, uuid } from './common';

export const reportRange = z.object({
  from: isoDate,
  to: isoDate,
  branchId: uuid.optional(),
});

export const reportKind = z.enum(['collections', 'tax', 'dues', 'memberships']);

export const reportExportQuery = z.object({
  kind: reportKind,
  from: isoDate.optional(),
  to: isoDate.optional(),
  branchId: uuid.optional(),
});

export type ReportRange = z.infer<typeof reportRange>;
