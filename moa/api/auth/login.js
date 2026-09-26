import { login } from '../../server/oauth.js';

export function GET(request) {
  return login(request, process.env);
}
