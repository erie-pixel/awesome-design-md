import { callback } from '../../server/oauth.js';

export function GET(request) {
  return callback(request, process.env);
}
