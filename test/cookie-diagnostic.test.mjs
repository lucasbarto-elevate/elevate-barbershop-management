import test from 'node:test';
import assert from 'node:assert/strict';
import cookieDiagnostic from '../netlify/functions/cookie-diagnostic.mjs';

const SITE_ID = 'bf28cab4-c90f-47ab-a2e7-cf103db41b71';
const PATH = '/.netlify/functions/cookie-diagnostic';
const context = { site: { id: SITE_ID } };

function request(method, path = PATH) {
  return new Request(`https://elevate-barbershop-staging.netlify.app${path}`, { method });
}

test('POST emits only a synthetic cookie with the required restrictions', async () => {
  const result = await cookieDiagnostic(request('POST'), context);
  const cookie = result.headers.get('set-cookie');
  const body = await result.json();

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(cookie, /^elevate_cookie_probe=synthetic-probe;/);
  assert.match(cookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Path=\/\.netlify\/functions\/cookie-diagnostic(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Max-Age=120(?:;|$)/i);
  assert.deepEqual(body, { ok: true, message: 'Synthetic cookie set.' });
  assert.doesNotMatch(JSON.stringify(body), /token|secret|cookie value/i);
});

test('DELETE clears the cookie at the same restricted path', async () => {
  const result = await cookieDiagnostic(request('DELETE'), context);
  const cookie = result.headers.get('set-cookie');

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(cookie, /^elevate_cookie_probe=;/);
  assert.match(cookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Path=\/\.netlify\/functions\/cookie-diagnostic(?:;|$)/i);
  assert.match(cookie, /(?:^|;\s*)Max-Age=0(?:;|$)/i);
});

test('wrong site, route, and method cannot use the diagnostic', async () => {
  const wrongSite = await cookieDiagnostic(request('POST'), { site: { id: 'production-site-id' } });
  const wrongPath = await cookieDiagnostic(request('POST', '/api/sync'), context);
  const wrongMethod = await cookieDiagnostic(request('GET'), context);

  assert.equal(wrongSite.status, 404);
  assert.equal(wrongSite.headers.get('set-cookie'), null);
  assert.equal(wrongPath.status, 404);
  assert.equal(wrongPath.headers.get('set-cookie'), null);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('set-cookie'), null);
});
