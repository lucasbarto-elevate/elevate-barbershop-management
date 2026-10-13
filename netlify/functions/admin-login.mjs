import { runAdminAuthOperation } from './_admin-session.mjs';

export default async request => runAdminAuthOperation('login', request);

export const config = {
  path: '/auth/admin/login',
  method: 'POST',
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};
