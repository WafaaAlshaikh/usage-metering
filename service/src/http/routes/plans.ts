import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { NotFoundError } from '../../domain/errors';
import { findVisiblePlan, listVisiblePlans } from '../../repo/plans';
import { archiveCustomPlan, createCustomPlan, updateCustomPlan } from '../../services/plans';
import { createPlanBody, listPlansQuery, patchPlanBody, planIdParams } from '../schemas/plans';
import { planView } from '../views';

export function plansRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get('/plans', async (req) => {
    const q = listPlansQuery.parse(req.query);
    const rows = await listVisiblePlans(db, req.account!.id, q);
    return { plans: rows.map(planView) };
  });

  app.get('/plans/:id', async (req) => {
    const { id } = planIdParams.parse(req.params);
    const plan = await findVisiblePlan(db, req.account!.id, id);
    if (!plan) throw new NotFoundError('Plan not found', { planId: id });
    return planView(plan);
  });

  app.post('/plans', async (req, reply) => {
    const body = createPlanBody.parse(req.body);
    const plan = await createCustomPlan(db, req.account!.id, body);
    return reply.status(201).send(planView(plan));
  });

  app.patch('/plans/:id', async (req) => {
    const { id } = planIdParams.parse(req.params);
    const patch = patchPlanBody.parse(req.body);
    return planView(await updateCustomPlan(db, req.account!.id, id, patch));
  });

  // Archive, not hard delete: current users keep it and history stays explainable.
  app.delete('/plans/:id', async (req) => {
    const { id } = planIdParams.parse(req.params);
    return planView(await archiveCustomPlan(db, req.account!.id, id));
  });
}