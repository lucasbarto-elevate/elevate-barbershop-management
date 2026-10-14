import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mountAdminLogin } from '../admin-login.js';

const htmlUrl = new URL('../admin-login.html', import.meta.url);
const cssUrl = new URL('../admin-login.css', import.meta.url);

function element() {
  const listeners = new Map();
  return {
    value: '', textContent: '', hidden: false, disabled: false, dataset: {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    async dispatch(type, event = {}) { return listeners.get(type)?.({ preventDefault() {}, ...event }); }
  };
}

function pageDocument() {
  const elements = new Map([
    'session-status', 'feedback', 'login-form', 'email', 'password', 'login-button', 'logout-button'
  ].map(id => [id, element()]));
  return { getElementById: id => elements.get(id) || null, elements };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('página é estática, isolada e apresenta o formulário sem ligar o Dashboard', async () => {
  const [html, css, script] = await Promise.all([
    readFile(htmlUrl, 'utf8'), readFile(cssUrl, 'utf8'), readFile(new URL('../admin-login.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /<html lang="pt-PT">/);
  assert.match(html, /id="email"[^>]*type="email"/);
  assert.match(html, /id="password"[^>]*type="password"/);
  assert.match(html, /admin-login\.css/);
  assert.match(html, /admin-login\.js/);
  assert.match(html, /Dashboard.*APIs de negócio ainda não estão protegidos/s);
  assert.match(html, /Content-Security-Policy/);
  assert.match(css, /\.login-card/);
  for (const forbidden of ['localStorage', 'sessionStorage', 'console.log', 'console.error', 'console.warn', '/api/data', '/api/version', '/api/sync']) {
    assert.equal(script.includes(forbidden), false, `unexpected auth/storage reference: ${forbidden}`);
  }
  for (const forbidden of ['/api/data', '/api/version', '/api/sync', 'dashboard.js', 'index.html']) {
    assert.equal(html.includes(forbidden), false, `unexpected application dependency: ${forbidden}`);
  }
});

test('GET de sessão inicial obtém CSRF em memória; login simulado confirma sessão e limpa password', async () => {
  const doc = pageDocument();
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === '/auth/admin/session' && requests.filter(item => item.url === url).length === 1) {
      return jsonResponse({ ok: true, authenticated: false, csrfToken: 'synthetic-csrf-token' });
    }
    if (url === '/auth/admin/login') return jsonResponse({ ok: true });
    return jsonResponse({ ok: true, authenticated: true, csrfToken: 'synthetic-csrf-token' });
  };
  const controller = mountAdminLogin({ document: doc, fetchImpl });
  await controller.ready;
  assert.equal(doc.elements.get('login-form').hidden, false);
  doc.elements.get('email').value = 'admin@example.invalid';
  doc.elements.get('password').value = 'synthetic-password';
  await doc.elements.get('login-form').dispatch('submit');

  const loginRequest = requests.find(item => item.url === '/auth/admin/login');
  assert.equal(loginRequest.options.method, 'POST');
  assert.equal(loginRequest.options.credentials, 'same-origin');
  assert.equal(loginRequest.options.headers['x-csrf-token'], 'synthetic-csrf-token');
  assert.deepEqual(JSON.parse(loginRequest.options.body), { email: 'admin@example.invalid', password: 'synthetic-password' });
  assert.equal(doc.elements.get('password').value, '');
  assert.equal(controller.authenticated, true);
  assert.equal(doc.elements.get('logout-button').hidden, false);
  assert.equal(requests.every(item => item.options.cache === 'no-store'), true);
});

test('logout só mostra sucesso depois de o servidor confirmar authenticated=false', async () => {
  const doc = pageDocument();
  const requests = [];
  let sessionReads = 0;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url === '/auth/admin/session') {
      sessionReads++;
      return jsonResponse({ ok: true, authenticated: sessionReads === 1, csrfToken: 'synthetic-csrf-token' });
    }
    return jsonResponse({ ok: true, authenticated: false });
  };
  const controller = mountAdminLogin({ document: doc, fetchImpl });
  await controller.ready;
  await doc.elements.get('logout-button').dispatch('click');
  const logoutRequest = requests.find(item => item.url === '/auth/admin/logout');
  assert.equal(logoutRequest.options.method, 'POST');
  assert.equal(logoutRequest.options.headers['x-csrf-token'], 'synthetic-csrf-token');
  assert.equal(controller.authenticated, false);
  assert.equal(doc.elements.get('login-form').hidden, false);
  assert.equal(doc.elements.get('feedback').textContent, 'Sessão terminada.');
  assert.equal(doc.elements.get('feedback').dataset.kind, 'success');
  assert.equal(requests.some(item => /localStorage|sessionStorage/.test(JSON.stringify(item))), false);
});

test('se a confirmação continuar autenticada, mantém o estado ativo sem mensagem de sucesso', async () => {
  const doc = pageDocument();
  let sessionReads = 0;
  const fetchImpl = async url => {
    if (url === '/auth/admin/session') {
      sessionReads++;
      return jsonResponse({ ok: true, authenticated: true, csrfToken: 'synthetic-csrf-token' });
    }
    return jsonResponse({ ok: true, authenticated: false });
  };
  const controller = mountAdminLogin({ document: doc, fetchImpl });
  await controller.ready;
  await doc.elements.get('logout-button').dispatch('click');
  assert.equal(sessionReads, 2);
  assert.equal(controller.authenticated, true);
  assert.equal(doc.elements.get('logout-button').hidden, false);
  assert.match(doc.elements.get('feedback').textContent, /sessão continua ativa/i);
  assert.notEqual(doc.elements.get('feedback').dataset.kind, 'success');
});

test('falha de rede ao confirmar logout não afirma que a sessão terminou', async () => {
  const doc = pageDocument();
  let sessionReads = 0;
  const fetchImpl = async url => {
    if (url === '/auth/admin/session') {
      sessionReads++;
      if (sessionReads === 2) throw new TypeError('synthetic network failure');
      return jsonResponse({ ok: true, authenticated: true, csrfToken: 'synthetic-csrf-token' });
    }
    return jsonResponse({ ok: true, authenticated: false });
  };
  const controller = mountAdminLogin({ document: doc, fetchImpl });
  await controller.ready;
  await doc.elements.get('logout-button').dispatch('click');
  assert.equal(controller.authenticated, false);
  assert.notEqual(doc.elements.get('feedback').textContent, 'Sessão terminada.');
  assert.notEqual(doc.elements.get('feedback').dataset.kind, 'success');
  assert.match(doc.elements.get('feedback').textContent, /não foi possível confirmar/i);
});

test('resposta inválida na confirmação é neutra e nunca mostra sucesso', async () => {
  const doc = pageDocument();
  let sessionReads = 0;
  const fetchImpl = async url => {
    if (url === '/auth/admin/session') {
      sessionReads++;
      return sessionReads === 1
        ? jsonResponse({ ok: true, authenticated: true, csrfToken: 'synthetic-csrf-token' })
        : jsonResponse({ ok: true, authenticated: 'unexpected', csrfToken: 'synthetic-csrf-token' });
    }
    return jsonResponse({ ok: true, authenticated: false });
  };
  const controller = mountAdminLogin({ document: doc, fetchImpl });
  await controller.ready;
  await doc.elements.get('logout-button').dispatch('click');
  assert.equal(controller.authenticated, false);
  assert.equal(doc.elements.get('session-status').textContent, 'Não foi possível verificar a sessão.');
  assert.notEqual(doc.elements.get('feedback').textContent, 'Sessão terminada.');
  assert.notEqual(doc.elements.get('feedback').dataset.kind, 'success');
  assert.match(doc.elements.get('feedback').textContent, /não foi possível confirmar/i);
});

test('falha no pedido de logout revalida o estado e não mostra sucesso', async () => {
  const doc = pageDocument();
  const fetchImpl = async url => url === '/auth/admin/session'
    ? jsonResponse({ ok: true, authenticated: true, csrfToken: 'synthetic-csrf-token' })
    : jsonResponse({ ok: false, error: 'synthetic internal detail' }, 403);
  const controller = mountAdminLogin({ document: doc, fetchImpl });
  await controller.ready;
  await doc.elements.get('logout-button').dispatch('click');
  assert.equal(controller.authenticated, true);
  assert.equal(doc.elements.get('logout-button').hidden, false);
  assert.notEqual(doc.elements.get('feedback').textContent, 'Sessão terminada.');
  assert.notEqual(doc.elements.get('feedback').dataset.kind, 'success');
  assert.match(doc.elements.get('feedback').textContent, /sessão continua ativa/i);
  assert.doesNotMatch(doc.elements.get('feedback').textContent, /synthetic internal detail/);
});

test('erros são genéricos e falha de sessão não exibe o formulário', async () => {
  const doc = pageDocument();
  const controller = mountAdminLogin({ document: doc, fetchImpl: async () => jsonResponse({ ok: false, error: 'internal secret detail' }, 503) });
  await controller.ready;
  assert.equal(doc.elements.get('login-form').hidden, true);
  assert.equal(doc.elements.get('feedback').textContent.includes('internal secret detail'), false);
  assert.equal(controller.authenticated, false);
});

test('password incorreta mostra mensagem simples e nunca é repetida na interface', async () => {
  const doc = pageDocument();
  let sessionReads = 0;
  const fetchImpl = async url => {
    if (url === '/auth/admin/session') {
      sessionReads++;
      return jsonResponse({ ok: true, authenticated: false, csrfToken: 'synthetic-csrf-token' });
    }
    return jsonResponse({ ok: false, error: 'internal detail' }, 401);
  };
  mountAdminLogin({ document: doc, fetchImpl });
  await new Promise(resolve => setImmediate(resolve));
  const syntheticPassword = 'synthetic-wrong-password';
  doc.elements.get('password').value = syntheticPassword;
  await doc.elements.get('login-form').dispatch('submit');
  assert.equal(doc.elements.get('feedback').textContent, 'Credenciais inválidas.');
  assert.equal(doc.elements.get('feedback').textContent.includes(syntheticPassword), false);
  assert.equal(doc.elements.get('password').value, '');
  assert.equal(sessionReads, 1);
});
