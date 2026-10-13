import { runAdminAuthOperation } from './_admin-session.mjs';

export default async request => runAdminAuthOperation('logout', request);

export const config = {
  path: '/auth/admin/logout',
  method: 'POST',
  rateLimit: {
    windowLimit: 10,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};
