/** Step A — ToolSearch. Run with: node step/stepA.js */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export function isDeferred(tool) {
  if (tool.alwaysLoad) return false;
  if (tool.isMcp) return true;
  if (tool.name === "ToolSearch") return false;
  return tool.shouldDefer === true;
}

export function discoveredTools(messages) {
  const names = new Set();
  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.startsWith("[CompactBoundary]")) {
        const match = message.content.match(/discovered_tools=(\S+)/);
        for (const name of match?.[1]?.split(",") ?? []) names.add(name);
      }
      continue;
    }
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const item of block.content) {
        if (item.type === "tool_reference") names.add(item.tool_name);
      }
    }
  }
  return names;
}

function parseName(name) {
  const mcp = name.startsWith("mcp__");
  const full = (mcp ? name.slice(5) : name.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .replace(/_+/g, " ").toLowerCase();
  return { mcp, full, parts: full.split(/\s+/) };
}

export function search(query, tools, maxResults = 5) {
  query = query.trim().toLowerCase();
  const deferred = tools.filter(isDeferred);
  const find = (name) => deferred.find((t) => t.name.toLowerCase() === name)
    ?? tools.find((t) => t.name.toLowerCase() === name);
  if (query.startsWith("select:")) {
    return [...new Set(query.slice(7).split(",").map((s) => find(s.trim())?.name).filter(Boolean))];
  }
  const exact = find(query);
  if (exact) return [exact.name];
  if (query.startsWith("mcp__") && query.length > 5) {
    const matches = deferred.filter((t) => t.name.toLowerCase().startsWith(query));
    if (matches.length) return matches.slice(0, maxResults).map((t) => t.name);
  }
  const raw = query.split(/\s+/).filter(Boolean);
  const required = raw.filter((s) => s.startsWith("+") && s.length > 1).map((s) => s.slice(1));
  const terms = [...required, ...raw.filter((s) => !(s.startsWith("+") && s.length > 1))];
  const patterns = new Map(terms.map((s) => [s, new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)]));
  return deferred.map((tool) => {
    const { mcp, full, parts } = parseName(tool.name);
    const description = tool.description.toLowerCase();
    const hint = (tool.searchHint ?? "").toLowerCase();
    const matches = (term) => parts.some((p) => p.includes(term))
      || patterns.get(term).test(description) || patterns.get(term).test(hint);
    if (!required.every(matches)) return { name: tool.name, score: 0 };
    let score = 0;
    for (const term of terms) {
      if (parts.includes(term)) score += mcp ? 12 : 10;
      else if (parts.some((p) => p.includes(term))) score += mcp ? 6 : 5;
      if (full.includes(term) && score === 0) score += 3;
      if (patterns.get(term).test(hint)) score += 4;
      if (patterns.get(term).test(description)) score += 2;
    }
    return { name: tool.name, score };
  }).filter((t) => t.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, maxResults).map((t) => t.name);
}

export function searchResult(id, names) {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: id,
    content: names.length ? names.map((name) => ({ type: "tool_reference", tool_name: name }))
      : [{ type: "text", text: "No matching deferred tools found" }],
  }] };
}

export function prepare(tools, messages, { enabled = true, protocol = "anthropic" } = {}) {
  enabled &&= tools.some((t) => t.name === "ToolSearch") && tools.some(isDeferred);
  const discovered = discoveredTools(messages);
  const selected = tools.filter((t) => enabled
    ? !isDeferred(t) || discovered.has(t.name)
    : t.name !== "ToolSearch");
  const schemas = selected.map((t) => ({ name: t.name, description: t.description,
    input_schema: t.inputSchema,
    ...(enabled && isDeferred(t) && protocol === "anthropic" ? { defer_loading: true } : {}),
  }));
  const copy = structuredClone(messages);
  for (const message of copy) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const siblings = [];
    let hasReferences = false;
    for (const block of message.content) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      const refs = block.content.filter((b) => b.type === "tool_reference");
      if (!refs.length) continue;
      const ordinary = block.content.filter((b) => b.type !== "tool_reference");
      const available = enabled ? refs.filter((r) => selected.some((t) => t.name === r.tool_name)) : [];
      if (available.length && protocol === "anthropic") {
        block.content = available;
        siblings.push(...ordinary);
        hasReferences = true;
      } else if (available.length) {
        const lines = available.map((r) => {
          const t = selected.find((t) => t.name === r.tool_name);
          return `<function>${JSON.stringify({ name: t.name, description: t.description, parameters: t.inputSchema })}</function>`;
        });
        block.content = [...ordinary, { type: "text", text: `<functions>\n${lines.join("\n")}\n</functions>` }];
      } else {
        block.content = ordinary.length ? ordinary : [{ type: "text", text: "[Tool references removed]" }];
      }
    }
    message.content.push(...siblings);
    if (hasReferences && !message.content.some((b) => b.type === "text" && b.text.startsWith("Tool loaded."))) {
      message.content.push({ type: "text", text: "Tool loaded." });
    }
  }
  if (enabled) {
    const names = tools.filter(isDeferred).map((t) => t.name).sort().join("\n");
    const text = { type: "text", text: `<available-deferred-tools>\n${names}\n</available-deferred-tools>` };
    if (copy[0]?.role === "user") {
      const first = copy[0];
      first.content = [text, ...(typeof first.content === "string" ? [{ type: "text", text: first.content }] : first.content)];
    } else copy.unshift({ role: "user", content: [text] });
  }
  return { tools: schemas, messages: copy,
    betas: enabled && protocol === "anthropic" ? ["advanced-tool-use-2025-11-20"] : [],
  };
}

export function main() {
  const tool = (name, extra = {}) => ({ name, description: name,
    inputSchema: { type: "object", properties: {} }, ...extra });
  const tools = [tool("Read"), tool("ToolSearch"),
    tool("TaskList", { shouldDefer: true }),
    tool("NotebookEdit", { shouldDefer: true, searchHint: "edit Jupyter notebook cells" }),
    tool("mcp__slack__send_message", { isMcp: true }),
    tool("mcp__health__status", { isMcp: true, alwaysLoad: true })];
  const history = [{ role: "user", content: "List my tasks" }];
  const first = prepare(tools, history);
  assert(!first.tools.some((t) => t.name === "TaskList"));
  assert(first.tools.some((t) => t.name === "mcp__health__status"));
  assert.deepEqual(search("jupyter", tools), ["NotebookEdit"]);
  assert.deepEqual(search("+slack send", tools), ["mcp__slack__send_message"]);
  assert.deepEqual(search("select:Read,missing,TaskList", tools), ["Read", "TaskList"]);
  history.push({ role: "assistant", content: [{ type: "tool_use", id: "search1", name: "ToolSearch", input: { query: "select:TaskList" } }] });
  history.push(searchResult("search1", search("select:TaskList", tools)));
  const second = prepare(tools, history);
  assert(second.tools.some((t) => t.name === "TaskList" && t.defer_loading));
  assert(!JSON.stringify(history).includes("Tool loaded."));
  const compacted = [{ role: "assistant", content: `[CompactBoundary] discovered_tools=${[...discoveredTools(history)].sort().join(",")}` }, { role: "user", content: "Continue" }];
  assert(prepare(tools, compacted).tools.some((t) => t.name === "TaskList"));
  const fallback = prepare(tools, history, { protocol: "openai-chat" });
  assert(JSON.stringify(fallback).includes("<functions>"));
  assert(!JSON.stringify(fallback).includes('"tool_reference"'));
  assert(!JSON.stringify(prepare(tools, history, { enabled: false })).includes('"tool_reference"'));
  console.log("First request:", first.tools.map((t) => t.name).join(", "));
  console.log("After discovery:", second.tools.map((t) => t.name).join(", "));
  console.log("Step A: all checks passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
