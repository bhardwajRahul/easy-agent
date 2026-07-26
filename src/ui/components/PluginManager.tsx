/**
 * PluginManager — interactive overlay for `/plugin` (no args).
 *
 * Mirrors the source's PluginSettings root view: one tabbed panel over the four
 * things a user actually manages, each backed by a different piece of state.
 *
 *   Discover      catalogued but not installed  → install
 *   Installed     install records + enable flags → enable/disable/update/remove
 *   Marketplaces  registered sources            → add/refresh/remove
 *   Errors        load failures from the runtime → read-only diagnostics
 *
 * The tab split is the point: install is global and version-locked, enable is
 * per-scope, and the marketplace is only a name→source resolver. Collapsing
 * them into one list would hide exactly the distinctions that matter.
 *
 * Self-contained like PermissionManager: it owns its keyboard (useInput) and
 * transient state (tab / cursor / scope / confirm / text buffer / busy). All
 * persisted changes go through `onMutate`, which reconciles the live registries
 * and feeds back a fresh snapshot.
 */

import React from "react";
import { Box, Text, useInput } from "ink";
import type { PluginMutation, PluginViewData } from "../../core/queryEngine.js";
import type { PluginScope } from "../../plugins/schemas.js";
import { theme, glyph } from "../theme.js";

interface PluginManagerProps {
  data: PluginViewData;
  /** Whether this overlay currently owns the keyboard. */
  active: boolean;
  /** Apply a change (engine write + registry reconcile), then refresh. */
  onMutate: (action: PluginMutation) => Promise<void>;
  /** Dismiss the overlay. */
  onClose: () => void;
}

type Tab = "discover" | "installed" | "marketplaces" | "errors";
type Mode = "list" | "addMarketplace" | "confirm";

const TABS: Tab[] = ["discover", "installed", "marketplaces", "errors"];
const SCOPES: PluginScope[] = ["user", "project", "local"];
const ADD_ROW = "\u2295 Add a marketplace\u2026";
const MAX_VISIBLE = 8;

function tabLabel(tab: Tab, data: PluginViewData): string {
  switch (tab) {
    case "discover":
      return `Discover ${data.available.length}`;
    case "installed":
      return `Installed ${data.installed.length}`;
    case "marketplaces":
      return `Marketplaces ${data.marketplaces.length}`;
    case "errors":
      return `Errors ${data.errors.length}`;
  }
}

function computeWindow(total: number, index: number): { start: number; end: number } {
  if (total <= MAX_VISIBLE) return { start: 0, end: total };
  let start = index - Math.floor(MAX_VISIBLE / 2);
  start = Math.max(0, Math.min(start, total - MAX_VISIBLE));
  return { start, end: start + MAX_VISIBLE };
}

/** Compact "3s 1a 2c" component summary; empty when the plugin contributes none. */
function componentSummary(c: PluginViewData["installed"][number]["components"]): string {
  const parts: string[] = [];
  if (c.skills) parts.push(`${c.skills} skill`);
  if (c.agents) parts.push(`${c.agents} agent`);
  if (c.commands) parts.push(`${c.commands} cmd`);
  if (c.outputStyles) parts.push(`${c.outputStyles} style`);
  if (c.hooks) parts.push(`${c.hooks} hook`);
  if (c.mcpServers) parts.push(`${c.mcpServers} mcp`);
  return parts.join(", ");
}

export function PluginManager({
  data,
  active,
  onMutate,
  onClose,
}: PluginManagerProps): React.ReactNode {
  const [tab, setTab] = React.useState<Tab>("installed");
  const [index, setIndex] = React.useState(0);
  const [mode, setMode] = React.useState<Mode>("list");
  const [buffer, setBuffer] = React.useState("");
  const [scope, setScope] = React.useState<PluginScope>("user");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  /** What a pending `confirm` will do once the user presses y. */
  const [pending, setPending] = React.useState<
    { action: PluginMutation; label: string } | null
  >(null);

  // Row counts per tab; the marketplaces tab reserves row 0 for "Add…".
  const total =
    tab === "discover"
      ? data.available.length
      : tab === "installed"
        ? data.installed.length
        : tab === "marketplaces"
          ? data.marketplaces.length + 1
          : data.errors.length;
  const clampedIndex = total === 0 ? 0 : Math.min(index, total - 1);

  const run = React.useCallback(
    (action: PluginMutation, label: string) => {
      setBusy(label);
      setFailure(null);
      void onMutate(action)
        .then(() => setBusy(null))
        .catch((err: unknown) => {
          setBusy(null);
          setFailure(err instanceof Error ? err.message : String(err));
        });
    },
    [onMutate],
  );

  useInput(
    (input, key) => {
      if (!active) return;
      if (key.ctrl || key.meta) return;
      // A mutation is in flight (possibly a git clone) — swallow input so the
      // user can't queue conflicting writes against the same state files.
      if (busy) return;

      if (mode === "addMarketplace") {
        if (key.escape) {
          setMode("list");
          setBuffer("");
          return;
        }
        if (key.return) {
          const source = buffer.trim();
          if (source) {
            run({ op: "marketplace-add", source }, `Adding ${source}`);
            setMode("list");
            setBuffer("");
          }
          return;
        }
        if (key.backspace || key.delete) {
          setBuffer((b) => b.slice(0, -1));
          return;
        }
        if (input && !key.return) setBuffer((b) => b + input);
        return;
      }

      if (mode === "confirm") {
        if ((input === "y" || input === "Y") && pending) {
          run(pending.action, pending.label);
          setPending(null);
          setMode("list");
          return;
        }
        if (input === "n" || input === "N" || key.escape) {
          setPending(null);
          setMode("list");
        }
        return;
      }

      // ── mode === "list" ──
      if (key.escape) {
        onClose();
        return;
      }
      if (key.tab || key.rightArrow) {
        setTab(TABS[(TABS.indexOf(tab) + 1) % TABS.length]!);
        setIndex(0);
        setFailure(null);
        return;
      }
      if (key.leftArrow) {
        setTab(TABS[(TABS.indexOf(tab) - 1 + TABS.length) % TABS.length]!);
        setIndex(0);
        setFailure(null);
        return;
      }
      if (key.upArrow) {
        if (total > 0) setIndex((i) => (Math.min(i, total - 1) - 1 + total) % total);
        return;
      }
      if (key.downArrow) {
        if (total > 0) setIndex((i) => (Math.min(i, total - 1) + 1) % total);
        return;
      }
      // `s` cycles the scope that install / enable writes to.
      if (input === "s") {
        setScope((s) => SCOPES[(SCOPES.indexOf(s) + 1) % SCOPES.length]!);
        return;
      }

      if (tab === "discover") {
        const row = data.available[clampedIndex];
        if (!row) return;
        if (key.return) {
          run({ op: "install", pluginId: row.pluginId, scope }, `Installing ${row.pluginId}`);
        }
        return;
      }

      if (tab === "installed") {
        const row = data.installed[clampedIndex];
        if (!row) return;
        if (key.return) {
          run(
            {
              op: row.enabled ? "disable" : "enable",
              pluginId: row.pluginId,
              // Disabling must target the scope that enabled it, otherwise we'd
              // write `false` into a layer the `true` doesn't live in.
              scope: row.enabled ? (row.scope ?? scope) : scope,
            },
            `${row.enabled ? "Disabling" : "Enabling"} ${row.pluginId}`,
          );
          return;
        }
        if (input === "u") {
          run({ op: "update", pluginId: row.pluginId, scope: row.scope ?? scope }, `Updating ${row.pluginId}`);
          return;
        }
        if (input === "x") {
          setPending({
            action: { op: "uninstall", pluginId: row.pluginId, scope: row.scope ?? scope },
            label: `Uninstalling ${row.pluginId}`,
          });
          setMode("confirm");
        }
        return;
      }

      if (tab === "marketplaces") {
        if (clampedIndex === 0) {
          if (key.return) {
            setMode("addMarketplace");
            setBuffer("");
          }
          return;
        }
        const row = data.marketplaces[clampedIndex - 1];
        if (!row) return;
        if (key.return || input === "u") {
          run({ op: "marketplace-update", name: row.name }, `Refreshing ${row.name}`);
          return;
        }
        if (input === "x") {
          setPending({
            action: { op: "marketplace-remove", name: row.name },
            label: `Removing ${row.name}`,
          });
          setMode("confirm");
        }
      }
    },
    { isActive: active },
  );

  // ── add-marketplace text prompt ──
  if (mode === "addMarketplace") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={theme.info}>{glyph.toolDot} </Text>
          <Text color={theme.info} bold>
            Add marketplace
          </Text>
          <Text color={theme.muted}>{"  Enter add · Esc cancel"}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text>{"source: "}</Text>
          <Text color={theme.brand}>{buffer}</Text>
          <Text color={theme.brand}>{"\u2588"}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>
            {"Examples: owner/repo · https://github.com/owner/repo.git · ./my-marketplace"}
          </Text>
        </Box>
      </Box>
    );
  }

  const { start, end } = computeWindow(total, clampedIndex);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={theme.info}>{glyph.toolDot} </Text>
        <Text color={theme.info} bold>
          Plugins
        </Text>
        <Text color={theme.muted}>{`  scope: ${scope}`}</Text>
      </Box>

      {/* Tab strip */}
      <Box marginLeft={2}>
        {TABS.map((t) => (
          <Text
            key={t}
            color={t === tab ? theme.brand : theme.muted}
            bold={t === tab}
          >
            {`[${tabLabel(t, data)}]  `}
          </Text>
        ))}
      </Box>

      {start > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`\u2191 ${start} more`}</Text>
        </Box>
      ) : null}

      {total === 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>
            {tab === "discover"
              ? data.marketplaces.length === 0
                ? "No marketplaces yet — switch to Marketplaces and add one."
                : "Every catalogued plugin is already installed."
              : tab === "installed"
                ? "Nothing installed — switch to Discover to browse."
                : "No plugin load errors."}
          </Text>
        </Box>
      ) : null}

      {/* ── Discover ── */}
      {tab === "discover"
        ? data.available.slice(start, end).map((row, offset) => {
            const selected = start + offset === clampedIndex;
            return (
              <Box key={row.pluginId}>
                <Text color={selected ? theme.brand : undefined} bold={selected} wrap="truncate-end">
                  {selected ? "\u25B6 " : "  "}
                  {row.pluginId}
                </Text>
                {row.version ? (
                  <Text color={theme.muted} dimColor>{`  v${row.version}`}</Text>
                ) : null}
                {row.description ? (
                  <Text color={theme.muted} dimColor wrap="truncate-end">{`  ${row.description}`}</Text>
                ) : null}
              </Box>
            );
          })
        : null}

      {/* ── Installed ── */}
      {tab === "installed"
        ? data.installed.slice(start, end).map((row, offset) => {
            const selected = start + offset === clampedIndex;
            const confirming = selected && mode === "confirm";
            const summary = componentSummary(row.components);
            return (
              <Box key={row.pluginId}>
                <Text color={row.enabled ? theme.ok : theme.muted}>
                  {selected ? "\u25B6 " : "  "}
                  {row.enabled ? "\u2713 " : "\u25CB "}
                </Text>
                <Text color={selected ? theme.brand : undefined} bold={selected} wrap="truncate-end">
                  {row.pluginId}
                </Text>
                <Text color={theme.muted} dimColor>
                  {`  v${row.version}${row.scope ? ` [${row.scope}]` : ""}${summary ? `  ${summary}` : ""}`}
                </Text>
                {row.enabled && !row.executablesTrusted && (row.components.hooks || row.components.mcpServers) ? (
                  <Text color={theme.warn}>{"  untrusted: hooks/mcp off"}</Text>
                ) : null}
                {row.errorCount > 0 ? (
                  <Text color={theme.error}>{`  ${row.errorCount} error`}</Text>
                ) : null}
                {confirming ? <Text color={theme.error}>{"  uninstall? y/n"}</Text> : null}
              </Box>
            );
          })
        : null}

      {/* ── Marketplaces (row 0 is the Add entry) ── */}
      {tab === "marketplaces" ? (
        <>
          {start === 0 ? (
            <Box>
              <Text color={clampedIndex === 0 ? theme.brand : theme.muted} bold={clampedIndex === 0}>
                {clampedIndex === 0 ? "\u25B6 " : "  "}
                {ADD_ROW}
              </Text>
            </Box>
          ) : null}
          {data.marketplaces
            .slice(Math.max(0, start - 1), Math.max(0, end - 1))
            .map((row, offset) => {
              const i = Math.max(0, start - 1) + offset + 1;
              const selected = i === clampedIndex;
              const confirming = selected && mode === "confirm";
              return (
                <Box key={row.name}>
                  <Text color={selected ? theme.brand : undefined} bold={selected} wrap="truncate-end">
                    {selected ? "\u25B6 " : "  "}
                    {row.name}
                  </Text>
                  <Text color={theme.muted} dimColor>
                    {`  [${row.kind}]${row.pluginCount !== null ? ` ${row.pluginCount} plugin` : ""}`}
                  </Text>
                  {row.error ? (
                    <Text color={theme.error} wrap="truncate-end">{`  ${row.error}`}</Text>
                  ) : null}
                  {confirming ? <Text color={theme.error}>{"  remove? y/n"}</Text> : null}
                </Box>
              );
            })}
        </>
      ) : null}

      {/* ── Errors ── */}
      {tab === "errors"
        ? data.errors.slice(start, end).map((row, offset) => {
            const selected = start + offset === clampedIndex;
            return (
              <Box key={`${row.pluginId}:${row.scope}:${offset}`} flexDirection="column">
                <Box>
                  <Text color={selected ? theme.brand : theme.error} bold={selected}>
                    {selected ? "\u25B6 " : "  "}
                    {row.pluginId}
                  </Text>
                  <Text color={theme.muted} dimColor>{`  [${row.scope}]`}</Text>
                </Box>
                <Box marginLeft={4}>
                  <Text color={theme.muted} wrap="truncate-end">
                    {row.message}
                  </Text>
                </Box>
              </Box>
            );
          })
        : null}

      {total - end > 0 ? (
        <Box marginLeft={2}>
          <Text color={theme.muted} dimColor>{`\u2193 ${total - end} more`}</Text>
        </Box>
      ) : null}

      {busy ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color={theme.warn}>{`${busy}\u2026`}</Text>
        </Box>
      ) : null}
      {failure ? (
        <Box marginLeft={2} marginTop={1}>
          <Text color={theme.error} wrap="truncate-end">{`failed: ${failure}`}</Text>
        </Box>
      ) : null}

      <Box marginLeft={2} marginTop={1}>
        <Text color={theme.muted} dimColor>
          {mode === "confirm"
            ? "y confirm · n cancel"
            : busy
              ? "working\u2026"
              : tab === "discover"
                ? "\u2191\u2193 navigate · Enter install · s scope · \u21b9/\u2190\u2192 tab · Esc close"
                : tab === "installed"
                  ? "\u2191\u2193 navigate · Enter toggle · u update · x uninstall · s scope · \u21b9 tab · Esc close"
                  : tab === "marketplaces"
                    ? "\u2191\u2193 navigate · Enter add/refresh · x remove · \u21b9 tab · Esc close"
                    : "\u2191\u2193 navigate · \u21b9 tab · Esc close"}
        </Text>
      </Box>
    </Box>
  );
}
