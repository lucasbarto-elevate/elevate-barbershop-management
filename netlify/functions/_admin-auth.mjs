import { timingSafeEqual } from 'node:crypto';

export function hasAdminAuthorization(header, secret) {
  if (!secret) return false;
  const supplied = String(header || '').match(/^Bearer (.+)$/i)?.[1] || '';
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(secret);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

