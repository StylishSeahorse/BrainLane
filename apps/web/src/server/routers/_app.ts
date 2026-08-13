import 'server-only';
import { router } from '../trpc';
import { taskRouter } from './task';
import { projectRouter } from './project';
import { planRouter } from './plan';
import { agentRouter } from './agent';
import { aiRouter } from './ai';
import { calendarRouter } from './calendar';
import { routineRouter } from './routine';

export const appRouter = router({
  task: taskRouter,
  project: projectRouter,
  plan: planRouter,
  agent: agentRouter,
  ai: aiRouter,
  calendar: calendarRouter,
  routine: routineRouter,
});

export type AppRouter = typeof appRouter;
