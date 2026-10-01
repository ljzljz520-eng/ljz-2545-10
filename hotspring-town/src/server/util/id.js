import { randomUUID } from 'node:crypto';
export const newId = (prefix = 'id') => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
