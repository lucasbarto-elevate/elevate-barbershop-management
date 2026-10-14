import { timingSafeEqual } from 'node:crypto';
import { ADMIN_CSRF_COOKIE } from './_admin-session.mjs';

export const AUTH_ROLES = Object.freeze({
  ADMIN: 'admin',
  BARBER_DEVICE: 'barber-device',
  PUBLIC: 'public'
});

export const DEVICE_CSRF_COOKIE = '__Host-elevate-device-csrf';

// These are server-defined capabilities. Request fields, headers, and URL
// parameters never select a role or add an operation to this matrix.
export const AUTH_OPERATIONS = Object.freeze({
  HEALTH_READ: 'health.read',
  CATALOG_READ: 'catalog.read',
  TODAY_SALES_READ: 'sales.today.read',
  SALES_CREATE: 'sales.create',
  SALES_EDIT: 'sales.edit',
  SALES_DELETE: 'sales.delete',
  CATALOG_WRITE: 'catalog.write',
  MANUAL_STOCK_WRITE: 'stock.manual.write',
  REPORTS_READ: 'reports.read',
  BACKUPS_MANAGE: 'backups.manage',
  DEVICES_MANAGE: 'devices.manage'
});

const OPERATION_ROLES = new Map([
  [AUTH_OPERATIONS.HEALTH_READ, new Set([AUTH_ROLES.PUBLIC, AUTH_ROLES.ADMIN, AUTH_ROLES.BARBER_DEVICE])],
  [AUTH_OPERATIONS.CATALOG_READ, new Set([AUTH_ROLES.ADMIN, AUTH_ROLES.BARBER_DEVICE])],
  [AUTH_OPERATIONS.TODAY_SALES_READ, new Set([AUTH_ROLES.ADMIN, AUTH_ROLES.BARBER_DEVICE])],
  [AUTH_OPERATIONS.SALES_CREATE, new Set([AUTH_ROLES.ADMIN, AUTH_ROLES.BARBER_DEVICE])],
  [AUTH_OPERATIONS.SALES_EDIT, new Set([AUTH_ROLES.ADMIN])],
  [AUTH_OPERATIONS.SALES_DELETE, new Set([AUTH_ROLES.ADMIN])],
  [AUTH_OPERATIONS.CATALOG_WRITE, new Set([AUTH_ROLES.ADMIN])],
  [AUTH_OPERATIONS.MANUAL_STOCK_WRITE, new Set([AUTH_ROLES.ADMIN])],
  [AUTH_OPERATIONS.REPORTS_READ, new Set([AUTH_ROLES.ADMIN])],
  [AUTH_OPERATIONS.BACKUPS_MANAGE, new Set([AUTH_ROLES.ADMIN])],
  [AUTH_OPERATIONS.DEVICES_MANAGE, new Set([AUTH_ROLES.ADMIN])]
]);

const CSRF_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class AuthorizationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
    this.code = code;
  }
}

function deny(status, code, message) {
  throw new AuthorizationError(status, code, message);
}

function isHttpsOrigin(value) {
  try {
    const parsed = new URL(value || '');
    return parsed.protocol === 'https:' && parsed.origin === value;
  } catch {
    return false;
  }
}

function parseCookies(request) {
  const result = new Map();
  for (const item of (request.headers.get('cookie') || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!result.has(name)) result.set(name, value);
  }
  return result;
}

function equalToken(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !CSRF_PATTERN.test(left) || !CSRF_PATTERN.test(right)) {
    return false;
  }
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizePrincipal(principal, expectedRole) {
  if (!principal || principal.role !== expectedRole || typeof principal.subjectId !== 'string' || !principal.subjectId.trim()) {
    deny(503, 'authorization_misconfigured', 'A identidade verificada não é válida.');
  }
  return principal;
}

/**
 * Create a fail-closed authorizer. Resolvers must authenticate opaque,
 * server-issued sessions; findDevice must read the server-side active-device
 * record. None may derive authority from request-supplied IDs or roles.
 */
export function createAuthorizer({ resolveAdminSession, resolveDeviceSession, findDevice, expectedOrigin } = {}) {
  if (typeof resolveAdminSession !== 'function' || typeof resolveDeviceSession !== 'function' ||
      typeof findDevice !== 'function' || !isHttpsOrigin(expectedOrigin)) {
    throw new TypeError('Resolvers de sessão, registo de dispositivo e Origin HTTPS são obrigatórios.');
  }

  async function resolvePrincipal(request) {
    let admin;
    try {
      admin = await resolveAdminSession(request);
    } catch {
      deny(503, 'admin_session_unavailable', 'Não foi possível verificar a sessão administrativa.');
    }
    if (admin) return normalizePrincipal(admin, AUTH_ROLES.ADMIN);

    let deviceSession;
    try {
      deviceSession = await resolveDeviceSession(request);
    } catch {
      deny(503, 'device_session_unavailable', 'Não foi possível verificar a sessão do dispositivo.');
    }
    if (!deviceSession) deny(401, 'unauthenticated', 'Autenticação necessária.');
    normalizePrincipal(deviceSession, AUTH_ROLES.BARBER_DEVICE);
    if (typeof deviceSession.deviceId !== 'string' || !deviceSession.deviceId.trim() ||
        !Number.isSafeInteger(deviceSession.generation) || deviceSession.generation < 1) {
      deny(403, 'device_not_authorized', 'Este dispositivo não está autorizado.');
    }

    let record;
    try {
      record = await findDevice(deviceSession.subjectId, deviceSession.deviceId);
    } catch {
      deny(503, 'device_registry_unavailable', 'Não foi possível verificar o dispositivo.');
    }
    if (!record || record.subjectId !== deviceSession.subjectId || record.deviceId !== deviceSession.deviceId ||
        !Number.isSafeInteger(record.generation) || record.generation !== deviceSession.generation) {
      deny(403, 'device_not_authorized', 'Este dispositivo não está autorizado.');
    }
    if (record.status !== 'active') deny(403, 'device_revoked', 'Este dispositivo está revogado ou inativo.');
    return deviceSession;
  }

  async function authorizeOperation(request, operation) {
    const allowedRoles = OPERATION_ROLES.get(operation);
    if (!allowedRoles) deny(503, 'authorization_misconfigured', 'A operação não tem uma política de autorização.');

    // The sole anonymous capability is a generic health check. It must not
    // return business data and does not grant access to any other operation.
    if (operation === AUTH_OPERATIONS.HEALTH_READ) {
      const hasCredential = Boolean(request.headers.get('cookie') || request.headers.get('authorization'));
      if (!hasCredential) return Object.freeze({ subjectId: 'public', role: AUTH_ROLES.PUBLIC });
    }

    const principal = await resolvePrincipal(request);
    if (!allowedRoles.has(principal.role)) {
      deny(403, 'insufficient_permission', 'A identidade não tem permissão para esta operação.');
    }
    return principal;
  }

  async function requireAdmin(request, operation = AUTH_OPERATIONS.REPORTS_READ) {
    const principal = await authorizeOperation(request, operation);
    if (principal.role !== AUTH_ROLES.ADMIN) deny(403, 'insufficient_permission', 'É necessária uma sessão administrativa.');
    return principal;
  }

  async function requireDevice(request, operation = AUTH_OPERATIONS.SALES_CREATE) {
    const principal = await authorizeOperation(request, operation);
    if (principal.role !== AUTH_ROLES.BARBER_DEVICE) deny(403, 'insufficient_permission', 'É necessária uma sessão de dispositivo autorizada.');
    return principal;
  }

  function validateOriginAndCsrf(request, principal) {
    if (request.headers.get('origin') !== expectedOrigin) {
      deny(403, 'origin_rejected', 'Pedido não autorizado.');
    }
    const cookieName = principal?.role === AUTH_ROLES.ADMIN
      ? ADMIN_CSRF_COOKIE
      : principal?.role === AUTH_ROLES.BARBER_DEVICE
        ? DEVICE_CSRF_COOKIE
        : null;
    if (!cookieName || !CSRF_PATTERN.test(principal.csrfToken || '')) {
      deny(403, 'csrf_rejected', 'Pedido não autorizado.');
    }
    const cookieToken = parseCookies(request).get(cookieName) || '';
    const headerToken = request.headers.get('x-csrf-token') || '';
    if (!equalToken(cookieToken, principal.csrfToken) || !equalToken(headerToken, principal.csrfToken)) {
      deny(403, 'csrf_rejected', 'Pedido não autorizado.');
    }
    return true;
  }

  async function requireAdminMutation(request, operation = AUTH_OPERATIONS.DEVICES_MANAGE) {
    const principal = await requireAdmin(request, operation);
    validateOriginAndCsrf(request, principal);
    return principal;
  }

  async function requireDeviceMutation(request, operation = AUTH_OPERATIONS.SALES_CREATE) {
    const principal = await requireDevice(request, operation);
    validateOriginAndCsrf(request, principal);
    return principal;
  }

  return Object.freeze({
    authorizeOperation,
    requireAdmin,
    requireDevice,
    requireAdminMutation,
    requireDeviceMutation,
    validateOriginAndCsrf
  });
}

/** Return a sanitized, non-cacheable response for authorization failures. */
export function authorizationErrorResponse(error) {
  if (!(error instanceof AuthorizationError)) {
    return Response.json(
      { ok: false, error: 'Não foi possível verificar a autorização.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return Response.json(
    { ok: false, error: error.message, code: error.code },
    { status: error.status, headers: { 'Cache-Control': 'no-store' } }
  );
}
