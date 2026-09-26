import { config } from '../../server/oauth.js';

export function GET() {
  return config(process.env);
}
