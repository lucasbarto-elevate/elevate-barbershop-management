const CSRF_HEADER = 'x-csrf-token';

function messageForStatus(status) {
  if (status === 401) return 'Credenciais inválidas.';
  if (status === 403) return 'Pedido não autorizado. Atualize a página e tente novamente.';
  if (status === 400) return 'Não foi possível validar os dados introduzidos.';
  if (status === 429) return 'Demasiadas tentativas. Aguarde um pouco e tente novamente.';
  return 'Não foi possível comunicar com o serviço de autenticação. Tente novamente.';
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

export function mountAdminLogin({ document: doc = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  if (!doc || typeof fetchImpl !== 'function') throw new TypeError('A document and fetch implementation are required.');

  const status = doc.getElementById('session-status');
  const feedback = doc.getElementById('feedback');
  const form = doc.getElementById('login-form');
  const email = doc.getElementById('email');
  const password = doc.getElementById('password');
  const loginButton = doc.getElementById('login-button');
  const logoutButton = doc.getElementById('logout-button');
  if (![status, feedback, form, email, password, loginButton, logoutButton].every(Boolean)) {
    throw new TypeError('The admin login page is missing required elements.');
  }

  let csrfToken = '';
  let authenticated = false;

  function showFeedback(text = '', kind = '') {
    feedback.textContent = text;
    feedback.dataset.kind = kind;
    feedback.hidden = !text;
  }

  function renderSession(isAuthenticated) {
    authenticated = isAuthenticated;
    status.textContent = isAuthenticated ? 'Sessão administrativa ativa neste navegador.' : 'Sessão não iniciada.';
    form.hidden = isAuthenticated;
    logoutButton.hidden = !isAuthenticated;
  }

  async function refreshSession() {
    status.textContent = 'A verificar sessão…';
    form.hidden = true;
    logoutButton.hidden = true;
    try {
      const response = await fetchImpl('/auth/admin/session', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true || typeof result.authenticated !== 'boolean' ||
          typeof result.csrfToken !== 'string' || !result.csrfToken) {
        throw new Error('session_unavailable');
      }
      csrfToken = result.csrfToken;
      renderSession(result.authenticated === true);
      return authenticated;
    } catch {
      csrfToken = '';
      authenticated = false;
      status.textContent = 'Não foi possível verificar a sessão.';
      form.hidden = true;
      logoutButton.hidden = true;
      showFeedback('Atualize a página ou tente novamente mais tarde.', 'error');
      return null;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    showFeedback();
    if (!csrfToken) {
      const ready = await refreshSession();
      if (!csrfToken || ready !== false) return;
    }

    loginButton.disabled = true;
    const submittedEmail = email.value;
    const submittedPassword = password.value;
    try {
      const response = await fetchImpl('/auth/admin/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', [CSRF_HEADER]: csrfToken },
        body: JSON.stringify({ email: submittedEmail, password: submittedPassword })
      });
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true) {
        showFeedback(messageForStatus(response.status), 'error');
        return;
      }

      password.value = '';
      showFeedback('Credenciais aceites. A confirmar a sessão…', 'success');
      await refreshSession();
    } catch {
      showFeedback('Não foi possível comunicar com o serviço de autenticação. Tente novamente.', 'error');
    } finally {
      // Drop the password from the form promptly; it is never persisted by this page.
      password.value = '';
      loginButton.disabled = false;
    }
  });

  logoutButton.addEventListener('click', async () => {
    showFeedback();
    if (!csrfToken) {
      showFeedback('Atualize a página antes de terminar a sessão.', 'error');
      return;
    }
    logoutButton.disabled = true;
    try {
      const response = await fetchImpl('/auth/admin/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', [CSRF_HEADER]: csrfToken },
        body: '{}'
      });
      const result = await readJson(response);
      if (!response.ok || result?.ok !== true || result?.authenticated !== false) {
        const current = await refreshSession();
        showFeedback(
          current === true
            ? 'Não foi possível confirmar o encerramento. A sessão continua ativa.'
            : 'Não foi possível confirmar o encerramento da sessão.',
          'error'
        );
        return;
      }
      csrfToken = '';
      const current = await refreshSession();
      if (current === false) {
        showFeedback('Sessão terminada.', 'success');
      } else {
        showFeedback(
          current === true
            ? 'Não foi possível confirmar o encerramento. A sessão continua ativa.'
            : 'Não foi possível confirmar o encerramento da sessão.',
          'error'
        );
      }
    } catch {
      const current = await refreshSession();
      showFeedback(
        current === true
          ? 'Não foi possível confirmar o encerramento. A sessão continua ativa.'
          : 'Não foi possível confirmar o encerramento da sessão.',
        'error'
      );
    } finally {
      logoutButton.disabled = false;
    }
  });

  const ready = refreshSession();
  return Object.freeze({ ready, refreshSession, get authenticated() { return authenticated; } });
}

if (typeof document !== 'undefined' && document.getElementById('admin-login-root')) {
  mountAdminLogin();
}
