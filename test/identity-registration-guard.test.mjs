import test from 'node:test';
import assert from 'node:assert/strict';
import identityEvents from '../netlify/functions/identity.mjs';

test('Identity validation rejects every signup attempt', () => {
  const attempts = [
    { email: 'barber@example.test', provider: 'email', roles: [] },
    { email: 'admin@example.test', provider: 'email', roles: ['admin'] },
    { email: 'person@example.test', provider: 'google', roles: [] },
    { provider: 'github', roles: ['barber-device'] },
    {}
  ];

  for (const user of attempts) {
    let denied = 0;
    const result = identityEvents.userValidate({
      user,
      deny() {
        denied += 1;
        return 'denied';
      }
    });

    assert.equal(denied, 1);
    assert.equal(result, 'denied');
  }
});

test('the Identity module only subscribes to user validation events', () => {
  assert.deepEqual(Object.keys(identityEvents), ['userValidate']);
});
