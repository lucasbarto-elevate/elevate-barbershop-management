const STAGING_SITE_ID = 'bf28cab4-c90f-47ab-a2e7-cf103db41b71';
const DIAGNOSTIC_PATH = '/.netlify/functions/cookie-diagnostic';
const COOKIE_NAME = 'elevate_cookie_probe';
const COOKIE_PATH = DIAGNOSTIC_PATH;
const COOKIE_MAX_AGE_SECONDS = 120;

function response(status, message) {
  return new Response(JSON.stringify({ ok: status < 400, message }), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function cookieValue() {
  // This is deliberately a fixed, non-secret probe value. It carries no identity
  // or authorization and is useful only to inspect the Set-Cookie attributes.
  return `${COOKIE_NAME}=synthetic-probe`;
}

export default async function cookieDiagnostic(req, context) {
  if (context?.site?.id !== STAGING_SITE_ID) return response(404, 'Not found.');

  let pathname;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return response(400, 'Invalid request URL.');
  }
  if (pathname !== DIAGNOSTIC_PATH) return response(404, 'Not found.');

  if (req.method === 'POST') {
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${cookieValue()}; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE_SECONDS}`
    });
    return new Response(JSON.stringify({ ok: true, message: 'Synthetic cookie set.' }), { status: 200, headers });
  }

  if (req.method === 'DELETE') {
    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    });
    return new Response(JSON.stringify({ ok: true, message: 'Synthetic cookie cleared.' }), { status: 200, headers });
  }

  return response(405, 'Method not allowed.');
}

export const config = { method: ['POST', 'DELETE'] };
