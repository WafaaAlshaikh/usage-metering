import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { buildOpenApi } from './openapi';

export function registerDocumentation(app: FastifyInstance, options: { adminTokenRequired: boolean; previewOnly?: boolean }): void {
  const document = buildOpenApi(options.adminTokenRequired, options.previewOnly);
  app.register(swagger, { mode: 'static', specification: { document } });
  app.register(swaggerUi, {
    routePrefix: '/docs',
    staticCSP: true,
    transformStaticCSP: header => header.replace(
      "style-src 'self'",
      "style-src 'self' 'sha256-RL3ie0nH+Lzz2YNqQN83mnU0J1ot4QL7b99vMdIX99w='",
    ) + " style-src-attr 'unsafe-inline';",
    uiConfig: {
      deepLinking: true,
      docExpansion: 'list',
      persistAuthorization: false,
      validatorUrl: null,
      ...(options.previewOnly ? { supportedSubmitMethods: [] } : {}),
    },
  });
  app.get('/openapi.json', async (_req, reply) => reply
    .header('content-disposition', 'attachment; filename="openapi.json"')
    .header('cache-control', 'no-store')
    .send(document));
  app.get('/openapi.yaml', async (_req, reply) => reply
    .type('application/yaml')
    .header('content-disposition', 'attachment; filename="openapi.yaml"')
    .header('cache-control', 'no-store')
    .send(app.swagger({ yaml: true })));
}
