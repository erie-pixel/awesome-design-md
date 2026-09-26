import { revoke } from '../../server/oauth.js';

export function POST(request) {
  return revoke(request, process.env);
}
