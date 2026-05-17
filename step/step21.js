/**
 * Step 21 - Agent Teams
 *
 * Goal:
 * - create one active team per session
 * - spawn named teammates through Agent({ name, team_name, ... })
 * - send messages through per-teammate inbox files
 * - inject unread inbox messages into a teammate's next turn
 * - delete a team only after teammates finish
 *
 * This file is a teaching version that condenses the core mechanics.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

// -----------------------------------------------------------------------------
// 1. Paths, team file, and active-team context
// -----------------------------------------------------------------------------

export const TEAM_LEAD_NAME = "team-lead";

export function isAgentTeamsEnabled() {
  const env = String(process.env.EASY_AGENT_TEAMS || "").toLowerCase();
  return process.argv.includes("--agent-teams") || ["1", "true", "yes", "on"].includes(env);
}

export function getTeamsRoot() {
  return process.env.EASY_AGENT_TEAMS_ROOT || path.join(os.homedir(), ".easy-agent", "teams");
}

export function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
}

export function formatAgentId(name, teamName) {
  return name + "@" + teamName;
}

export function getTeamDir(teamName) {
  return path.join(getTeamsRoot(), sanitizeName(teamName));
}

export function getTeamFilePath(teamName) {
  return path.join(getTeamDir(teamName), "team.json");
}

export async function readTeamFile(teamName) {
  try {
    return JSON.parse(await fs.readFile(getTeamFilePath(teamName), "utf8"));
  } catch {
    return null;
  }
}

export async function writeTeamFile(teamName, file) {
  await fs.mkdir(getTeamDir(teamName), { recursive: true });
  await fs.writeFile(getTeamFilePath(teamName), JSON.stringify(file, null, 2));
}

export async function cleanupTeamDirectory(teamName) {
  await fs.rm(getTeamDir(teamName), { recursive: true, force: true });
}

export async function addTeamMember(teamName, member) {
  const file = await readTeamFile(teamName);
  if (!file) return null;
  const members = file.members.filter((m) => m.name !== member.name);
  members.push(member);
  const next = { ...file, members };
  await writeTeamFile(teamName, next);
  return next;
}

export async function setMemberActive(teamName, memberName, isActive) {
  const file = await readTeamFile(teamName);
  if (!file) return null;
  const next = {
    ...file,
    members: file.members.map((m) => (m.name === memberName ? { ...m, isActive } : m)),
  };
  await writeTeamFile(teamName, next);
  return next;
}

let activeTeam = null;

export function getActiveTeam() {
  return activeTeam;
}

export function setActiveTeam(ctx) {
  if (activeTeam && activeTeam.teamName !== ctx.teamName) {
    throw new Error("Already leading team " + activeTeam.teamName);
  }
  activeTeam = ctx;
}

export function clearActiveTeam() {
  activeTeam = null;
}

// -----------------------------------------------------------------------------
// 2. Mailbox
// -----------------------------------------------------------------------------

export function getInboxPath(agentName, teamName) {
  return path.join(getTeamDir(teamName), "inboxes", sanitizeName(agentName) + ".json");
}

async function ensureInboxFile(agentName, teamName) {
  const inboxPath = getInboxPath(agentName, teamName);
  await fs.mkdir(path.dirname(inboxPath), { recursive: true });
  try {
    await fs.writeFile(inboxPath, "[]", { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return inboxPath;
}

export async function readMailbox(agentName, teamName) {
  try {
    const parsed = JSON.parse(await fs.readFile(getInboxPath(agentName, teamName), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writeToMailbox(recipientName, message, teamName) {
  const inboxPath = await ensureInboxFile(recipientName, teamName);
  let release;
  try {
    release = await lockfile.lock(inboxPath, {
      retries: { retries: 20, minTimeout: 5, maxTimeout: 80 },
    });
    const messages = await readMailbox(recipientName, teamName);
    messages.push({ ...message, read: false });
    await fs.writeFile(inboxPath, JSON.stringify(messages, null, 2));
  } finally {
    if (release) await release().catch(() => {});
  }
}

export async function drainUnreadMessages(agentName, teamName) {
  const inboxPath = getInboxPath(agentName, teamName);
  let release;
  try {
    release = await lockfile.lock(inboxPath, {
      retries: { retries: 20, minTimeout: 5, maxTimeout: 80 },
    });
    const messages = await readMailbox(agentName, teamName);
    const unread = messages.filter((m) => !m.read);
    if (!unread.length) return [];
    const next = messages.map((m) => (m.read ? m : { ...m, read: true }));
    await fs.writeFile(inboxPath, JSON.stringify(next, null, 2));
    return unread;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  } finally {
    if (release) await release().catch(() => {});
  }
}

export function formatMailboxAttachment(messages) {
  if (!messages.length) return "";
  return [
    "<teammate-messages>",
    "The following message(s) were sent to you by other team members.",
    "",
    ...messages.map((m) => {
      const attrs = [`from="${m.from}"`, `at="${m.timestamp}"`];
      if (m.summary) attrs.push(`summary="${m.summary}"`);
      return "<teammate-message " + attrs.join(" ") + ">\n" + m.text + "\n</teammate-message>";
    }),
    "</teammate-messages>",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// 3. Team tools
// -----------------------------------------------------------------------------

export const teamCreateTool = {
  name: "TeamCreate",
  inputSchema: {
    type: "object",
    properties: {
      team_name: { type: "string" },
      description: { type: "string" },
    },
    required: ["team_name"],
    additionalProperties: false,
  },

  async call(input) {
    if (!isAgentTeamsEnabled()) {
      return { content: "Error: Agent Teams is not enabled.", isError: true };
    }
    const teamName = typeof input.team_name === "string" ? input.team_name.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!teamName) return { content: "Error: team_name is required.", isError: true };
    if (activeTeam) {
      return { content: "Error: already leading team " + activeTeam.teamName + ".", isError: true };
    }
    if (await readTeamFile(teamName)) {
      return { content: "Error: team already exists on disk: " + getTeamFilePath(teamName), isError: true };
    }

    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName);
    const createdAt = Date.now();
    const file = {
      name: teamName,
      description: description || undefined,
      createdAt,
      leadAgentId,
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: "team-lead",
          joinedAt: createdAt,
          isActive: true,
        },
      ],
    };

    await writeTeamFile(teamName, file);
    setActiveTeam({ teamName, leadAgentId, teamFilePath: getTeamFilePath(teamName), createdAt });

    return {
      content:
        'Team "' +
        teamName +
        '" created. Spawn teammates with Agent({ name, team_name, run_in_background: true, ... }).',
    };
  },

  isEnabled: () => isAgentTeamsEnabled(),
};

function senderNameFromContext(context) {
  return context?.teammateIdentity?.agentName || TEAM_LEAD_NAME;
}

export const sendMessageTool = {
  name: "SendMessage",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string" },
      message: { type: "string" },
      summary: { type: "string" },
    },
    required: ["to", "message"],
    additionalProperties: false,
  },

  async call(input, context = {}) {
    if (!isAgentTeamsEnabled()) {
      return { content: "Error: Agent Teams is not enabled.", isError: true };
    }
    if (!activeTeam) return { content: "Error: no active team.", isError: true };

    const to = typeof input.to === "string" ? input.to.trim() : "";
    const message = typeof input.message === "string" ? input.message : "";
    const summary = typeof input.summary === "string" ? input.summary.trim() : undefined;
    if (!to || !message.trim()) {
      return { content: "Error: to and message are required.", isError: true };
    }

    const file = await readTeamFile(activeTeam.teamName);
    if (!file) return { content: "Error: active team file is missing.", isError: true };

    const from = senderNameFromContext(context);
    const timestamp = new Date().toISOString();

    if (to === "*") {
      const recipients = file.members.filter((m) => m.isActive && m.name !== from);
      for (const r of recipients) {
        await writeToMailbox(r.name, { from, text: message, timestamp, summary }, activeTeam.teamName);
      }
      return { content: "Broadcast message to " + recipients.map((r) => r.name).join(", ") + "." };
    }

    const recipient = file.members.find((m) => m.name === to);
    if (!recipient) {
      return {
        content: "Error: no teammate named " + to + ". Known: " + file.members.map((m) => m.name).join(", "),
        isError: true,
      };
    }
    if (to === from) return { content: "Error: cannot SendMessage to yourself.", isError: true };

    await writeToMailbox(to, { from, text: message, timestamp, summary }, activeTeam.teamName);
    return {
      content:
        'Message delivered to "' +
        to +
        '" inbox in team "' +
        activeTeam.teamName +
        '".',
    };
  },

  isEnabled: () => isAgentTeamsEnabled(),
};

export const teamDeleteTool = {
  name: "TeamDelete",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },

  async call() {
    if (!isAgentTeamsEnabled()) {
      return { content: "Error: Agent Teams is not enabled.", isError: true };
    }
    if (!activeTeam) return { content: "Error: no team is active.", isError: true };

    const file = await readTeamFile(activeTeam.teamName);
    if (!file) {
      clearActiveTeam();
      return { content: "Team file was already missing. Cleared active team." };
    }

    const activeTeammates = file.members.filter((m) => m.name !== TEAM_LEAD_NAME && m.isActive);
    if (activeTeammates.length) {
      return {
        content:
          "Error: cannot delete team while teammates are active: " +
          activeTeammates.map((m) => m.name).join(", "),
        isError: true,
      };
    }

    await cleanupTeamDirectory(activeTeam.teamName);
    const name = activeTeam.teamName;
    clearActiveTeam();
    return { content: 'Team "' + name + '" disbanded.' };
  },

  isEnabled: () => isAgentTeamsEnabled(),
};

// -----------------------------------------------------------------------------
// 4. Agent tool upgrade for named teammates
// -----------------------------------------------------------------------------

export function createTeamAwareAgentTool({
  registerBackgroundAgent = async () => ({ outputFile: "/tmp/teammate.output" }),
  findAgent = (agentType) => ({ agentType, getSystemPrompt: () => "demo" }),
} = {}) {
  return {
    name: "Agent",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        subagent_type: { type: "string" },
        run_in_background: { type: "boolean" },
        name: { type: "string" },
        team_name: { type: "string" },
      },
      required: ["prompt", "description"],
      additionalProperties: false,
    },

    async call(input, context = {}) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
      const teammateName = typeof input.name === "string" ? input.name.trim() : "";
      const teamName = typeof input.team_name === "string" ? input.team_name.trim() : "";
      const agentType = input.subagent_type || "general-purpose";
      if (!prompt) return { content: "Error: prompt is required.", isError: true };

      if (teammateName || teamName) {
        if (!isAgentTeamsEnabled()) {
          return { content: "Error: Agent Teams is not enabled.", isError: true };
        }
        if (!teammateName || !teamName) {
          return { content: "Error: name and team_name must be set together.", isError: true };
        }
        if (teammateName === TEAM_LEAD_NAME) {
          return { content: "Error: team-lead is reserved.", isError: true };
        }
        if (!activeTeam || activeTeam.teamName !== teamName) {
          return { content: "Error: team_name does not match the active team.", isError: true };
        }
        if (context.teammateIdentity) {
          return { content: "Error: teammates cannot spawn nested teammates.", isError: true };
        }
        if (input.run_in_background !== true) {
          return { content: "Error: named teammates must run in the background.", isError: true };
        }

        const agent = findAgent(agentType);
        const teammate = {
          agentId: formatAgentId(teammateName, teamName),
          name: teammateName,
          agentType: agent.agentType,
          joinedAt: Date.now(),
          isActive: true,
        };
        const launched = await registerBackgroundAgent({
          agent,
          prompt,
          teammateIdentity: { agentId: teammate.agentId, agentName: teammateName, teamName },
        });
        await addTeamMember(teamName, { ...teammate, outputFile: launched.outputFile });

        return {
          content:
            "Teammate '" +
            teammateName +
            "' joined team '" +
            teamName +
            "'. SendMessage({ to: \"" +
            teammateName +
            "\", ... }) can reach it.",
        };
      }

      return { content: "Plain one-shot Agent call would run here." };
    },
  };
}

// -----------------------------------------------------------------------------
// 5. Team prompt reminder
// -----------------------------------------------------------------------------

export async function formatTeamSystemReminder() {
  if (!isAgentTeamsEnabled()) return "";
  if (!activeTeam) {
    return [
      "<system-reminder>",
      "Agent Teams is enabled. Use TeamCreate for tasks that split into long-running parallel roles.",
      "</system-reminder>",
    ].join("\n");
  }

  const file = await readTeamFile(activeTeam.teamName);
  const members = file?.members || [];
  const teammates = members.filter((m) => m.name !== TEAM_LEAD_NAME);
  const lines = teammates.length
    ? teammates.map((m) => "- " + m.name + " [" + (m.isActive ? "active" : "idle") + "]")
    : ["- (No teammates yet.)"];

  return [
    "<system-reminder>",
    'Agent Teams: you are lead of team "' + activeTeam.teamName + '".',
    "Team members:",
    ...lines,
    "Use Agent({ name, team_name, run_in_background: true, ... }) to spawn teammates.",
    "Use SendMessage({ to, message }) to coordinate.",
    "Use TeamDelete() only after teammates finish.",
    "</system-reminder>",
  ].join("\n");
}

// -----------------------------------------------------------------------------
// 6. Demo
// -----------------------------------------------------------------------------

export async function demoStep21() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "easy-agent-step21-"));
  const prevFlag = process.env.EASY_AGENT_TEAMS;
  const prevRoot = process.env.EASY_AGENT_TEAMS_ROOT;
  process.env.EASY_AGENT_TEAMS = "1";
  process.env.EASY_AGENT_TEAMS_ROOT = path.join(tmp, "teams");

  try {
    clearActiveTeam();
    const created = await teamCreateTool.call({ team_name: "dev-team" });

    const agentTool = createTeamAwareAgentTool({
      registerBackgroundAgent: async () => ({ outputFile: path.join(tmp, "backend.output") }),
    });
    const teammate = await agentTool.call({
      prompt: "Work on backend API",
      description: "Backend work",
      name: "backend",
      team_name: "dev-team",
      run_in_background: true,
    });

    const sent = await sendMessageTool.call({
      to: "backend",
      summary: "API update",
      message: "The auth endpoint moved to /v2/login.",
    });

    const unread = await drainUnreadMessages("backend", "dev-team");
    const attachment = formatMailboxAttachment(unread);

    await setMemberActive("dev-team", "backend", false);
    const deleted = await teamDeleteTool.call({});

    return { created, teammate, sent, attachment, deleted };
  } finally {
    clearActiveTeam();
    if (prevFlag === undefined) delete process.env.EASY_AGENT_TEAMS;
    else process.env.EASY_AGENT_TEAMS = prevFlag;
    if (prevRoot === undefined) delete process.env.EASY_AGENT_TEAMS_ROOT;
    else process.env.EASY_AGENT_TEAMS_ROOT = prevRoot;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
