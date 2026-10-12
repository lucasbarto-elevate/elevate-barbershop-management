/**
 * Shared server-side authorization policy for Netlify Functions.
 *
 * The caller must provide a trusted Identity resolver (in deployment, getUser
 * from @netlify/identity) and a server-side device registry lookup. This module
 * deliberately has no header, environment, local-development, or test bypass.
 * Tests inject fixtures through the same explicit dependency boundary.
 */

export const AUTH_ROLES = Object.freeze({
  ADMIN: 'admin',
  BARBER_DEVICE: 'barber-device'
});

const VALID_ROLES = new Set(Object.values(AUTH_ROLES));

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

/**
 * Create a policy checker for a trusted Identity resolver and device registry.
 *
 * getIdentity(request) must return the verified Netlify Identity user or null.
 * findDevice(identityId) must read the server-side record for that verified
 * Identity ID. A device record is active only when it has the shape
 * { identityId, deviceId, status: 'active' }.
 */
export function createAuthorizer({ getIdentity, findDevice } = {}) {
  if (typeof getIdentity !== 'function' || typeof findDevice !== 'function') {
    throw new TypeError('A resolução de Identity e o registo de dispositivos são obrigatórios.');
  }

  return async function authorize(request, requiredRole) {
    if (!VALID_ROLES.has(requiredRole)) {
      deny(503, 'authorization_misconfigured', 'A política de autorização não está configurada.');
    }

    let identity;
    try {
      identity = await getIdentity(request);
    } catch {
      deny(503, 'identity_unavailable', 'Não foi possível verificar a identidade.');
    }

    if (!identity) deny(401, 'unauthenticated', 'Autenticação necessária.');

    const identityId = typeof identity.id === 'string' ? identity.id.trim() : '';
    const roles = identity.roles;
    if (!identityId || !Array.isArray(roles) || roles.some(role => typeof role !== 'string')) {
      deny(401, 'invalid_identity', 'A identidade não é válida.');
    }

    // These principals are intentionally exclusive: a device identity must
    // never gain administrator access by carrying both roles.
    if (roles.includes(AUTH_ROLES.ADMIN) && roles.includes(AUTH_ROLES.BARBER_DEVICE)) {
      deny(403, 'ambiguous_roles', 'Os papéis da identidade não são válidos.');
    }

    if (!roles.includes(requiredRole)) {
      deny(403, 'insufficient_role', 'A identidade não tem permissão para esta operação.');
    }

    if (requiredRole === AUTH_ROLES.ADMIN) {
      return Object.freeze({ subjectId: identityId, role: AUTH_ROLES.ADMIN });
    }

    let device;
    try {
      device = await findDevice(identityId);
    } catch {
      deny(503, 'device_registry_unavailable', 'Não foi possível verificar o dispositivo.');
    }

    if (!device || device.identityId !== identityId || typeof device.deviceId !== 'string' || !device.deviceId.trim()) {
      deny(403, 'device_not_authorized', 'Este dispositivo não está autorizado.');
    }
    if (device.status !== 'active') {
      deny(403, 'device_revoked', 'Este dispositivo está revogado ou inativo.');
    }

    return Object.freeze({
      subjectId: identityId,
      role: AUTH_ROLES.BARBER_DEVICE,
      deviceId: device.deviceId
    });
  };
}

/** Return a sanitized HTTP response for an authorization failure. */
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
