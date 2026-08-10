import 'server-only';
import { router } from '../trpc';
import { taskRouter } from './task';
import { projectRouter } from './project';
import { planRouter } from './plan';
import { agentRouter } from './agent';

export const appRouter = router({
  task: taskRouter,
  project: projectRouter,
  plan: planRouter,
  agent: agentRouter,
});

export type AppRouter = typeof appRouter;
