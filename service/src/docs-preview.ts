import Fastify from 'fastify';
import { registerDocumentation } from './http/docs/register';

// A real documentation server, not a mock metering API. No database or secrets needed.
async function main() {
  const app = Fastify({ logger: true });
  registerDocumentation(app, { adminTokenRequired: true, previewOnly: true });
  app.get('/', async (_req, reply) => reply.redirect('/docs/'));
  await app.listen({ port: 5000, host: '0.0.0.0' });
  const shutdown = () => void app.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
