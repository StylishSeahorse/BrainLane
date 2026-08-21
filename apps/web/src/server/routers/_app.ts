import 'server-only';
import { router } from '../trpc';
import { taskRouter } from './task';
import { projectRouter } from './project';
import { planRouter } from './plan';
import { agentRouter } from './agent';
import { aiRouter } from './ai';
import { calendarRouter } from './calendar';
import { routineRouter } from './routine';
import { dayRouter } from './day';
import { boardRouter } from './board';
import { areaRouter } from './area';
import { objectiveRouter } from './objective';

export const appRouter = router({
  task: taskRouter,
  project: projectRouter,
  plan: planRouter,
  agent: agentRouter,
  ai: aiRouter,
  calendar: calendarRouter,
  routine: routineRouter,
  day: dayRouter,
  board: boardRouter,
  area: areaRouter,
  objective: objectiveRouter,
});

export type AppRouter = typeof appRouter;
