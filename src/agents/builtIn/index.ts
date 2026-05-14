/**
 * Aggregator for built-in Agent definitions.
 *
 * Adding a new built-in agent: import the new definition here and add it
 * to the array. Custom user/project agents with the same `agentType` will
 * still override it.
 */

import type { AgentDefinition } from "../types.js";
import { GENERAL_PURPOSE_AGENT } from "./generalPurpose.js";
import { EXPLORE_AGENT } from "./explore.js";

export function getBuiltInAgents(): AgentDefinition[] {
  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT];
}

export { GENERAL_PURPOSE_AGENT, EXPLORE_AGENT };
