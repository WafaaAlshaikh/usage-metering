import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { registerUser } from '../../services/users';
import { createUserBody } from '../schemas/users';

export function usersRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.post('/users', async (req, reply) => {
    const body = createUserBody.parse(req.body);
    const { user, created } = await registerUser(deps.db, { accountId: req.account!.id, ...body });
    return reply.status(created ? 201 : 200).send({
      userId: user.externalId,
      planId: user.userPlanId,
      createdAt: user.createdAt,
      reactivated: !created,
    });
  });
}