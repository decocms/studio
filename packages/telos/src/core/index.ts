// The Aristotelian core: a frozen goal (mover) measured against an observed world
// (domain), pursued by an agent (eudaimon) via swappable reasoning (deliberator),
// over an event bus. Depends only on zod — never the AI SDK.

export type { Awaitable } from "./awaitable";
export { type GoalSource, UnmovedMover } from "./mover";
export { type GoalLedger, InMemoryGoalLedger } from "./ledger";
export type {
  Action,
  ActionAudience,
  Domain,
  PursuitContext,
} from "./domain";
export {
  type DomainEvent,
  type DomainEventType,
  type EventBus,
  type EventHandler,
  inMemoryBus,
} from "./events";
export {
  type ActionOutcome,
  applyAction,
  type Deliberator,
  isVetoError,
  VetoError,
} from "./deliberator";
export {
  type ApproveGoal,
  Eudaimon,
  type EudaimonDeps,
  type GoalProposal,
  type GoalProposer,
  type PursuitAction,
  type PursuitOutcome,
  type VetoedAction,
  wire,
} from "./eudaimon";
export {
  type Guard,
  type Telos,
  type TelosMeasure,
  telosProgress,
  type TelosProgress,
} from "./telos";
