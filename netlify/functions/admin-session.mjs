import { runAdminAuthOperation } from './_admin-session.mjs';

export default async request => runAdminAuthOperation('session', request);

export const config = {
  path: '/auth/admin/session',
  method: 'GET',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain']
  }
};
