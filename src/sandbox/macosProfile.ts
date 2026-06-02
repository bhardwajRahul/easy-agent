/**
 * Compile a SandboxProfile into macOS Seatbelt Policy Language (SBPL).
 *
 * SBPL is a tiny Scheme-like DSL consumed by `sandbox-exec -p '...'`.
 * The profile we emit follows this layout:
 *
 *   (version 1)
 *   (deny default)                       ; deny everything by default
 *   (allow process-fork process-exec)    ; the bash subprocess needs to spawn
 *   (allow file-read*)                   ; we don't restrict reads in this version
 *   (allow file-write*  (subpath ...))   ; cwd, tmp, +allowWrite
 *   (deny  file-write*  (subpath ...))   ; system paths, settings, skills
 *   (allow network-outbound (remote ip)) ; allowed networking
 *   (allow signal mach-lookup ...)       ; misc UNIX/macOS ops
 *
 * Notable differences from production sandbox-runtime:
 *
 *   - We allow ALL file reads. The tutorial focuses on "prevent write
 *     escape" + "prevent network egress", which already demonstrates
 *     the architecture. Adding read restrictions doubles the SBPL
 *     complexity for marginal teaching value. Source code DOES restrict
 *     reads (denyRead) but it's optional in their model too.
 *
 *   - We allow `network-outbound` only by IP. SBPL's hostname filter
 *     is unreliable (relies on getaddrinfo at policy-eval time which
 *     is not what the sandboxed process actually resolves). For the
 *     teaching version we allow any outbound connection when the
 *     allowed-domains list is non-empty, and document this as a
 *     known limitation. Production uses an HTTPS proxy + connect-only
 *     policy, which is far beyond tutorial scope.
 *
 *   - We use `subpath` for both files and directories. Paths are
 *     escaped with double-quote string literals.
 */

import type { SandboxProfile } from "./types.js";

function escapeSbplString(value: string): string {
  // SBPL string literals support backslash escapes for `\` and `"`.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function subpath(p: string): string {
  return `(subpath "${escapeSbplString(p)}")`;
}

function literal(p: string): string {
  return `(literal "${escapeSbplString(p)}")`;
}

/**
 * Standard device nodes that MUST stay writable even under a deny-default
 * profile. These aren't real filesystem writes — they're kernel-managed
 * pseudo-devices that ordinary commands open constantly:
 *
 *   - /dev/null, /dev/zero            redirects like `2>/dev/null`
 *   - /dev/stdout, /dev/stderr,       explicit fd redirects + `tee`-style tools
 *     /dev/stdin, /dev/fd/*           and process substitution `<(...)`
 *   - /dev/tty, /dev/ptmx             interactive prompts / pty allocation
 *   - /dev/random, /dev/urandom       crypto seeding (node, openssl, git)
 *   - /dev/dtracehelper, /dev/null... macOS runtime/libsystem chatter
 *
 * Without these, the very common `cmd 2>/dev/null` aborts with
 * "Operation not permitted" and the whole command fails. Production
 * Seatbelt profiles always whitelist this exact set.
 */
const STANDARD_DEVICE_WRITE_PATHS = [
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/ptmx",
  "/dev/random",
  "/dev/urandom",
  "/dev/dtracehelper",
];

export function compileMacosProfile(profile: SandboxProfile): string {
  const writableSubpaths = profile.filesystem.allowWrite.map(subpath).join(" ");
  const denyWriteSubpaths = profile.filesystem.denyWrite.map(subpath).join(" ");

  const networkAllowAll = profile.network.allowedDomains.length > 0;

  // SBPL evaluates rules in source order; later rules override earlier
  // ones. So we emit `(allow file-write*)` for our writable list FIRST,
  // then `(deny file-write*)` for the critical paths, so the deny wins
  // even if a writable path overlaps a critical path (e.g. user adds
  // cwd to allowWrite but settings.json lives inside cwd — we must
  // still deny writes to settings.json).
  // Standard device nodes + /dev/fd (process substitution). Emitted AFTER
  // the deny block so nothing can override them — these are kernel pseudo-
  // devices, never a write-escape vector, and ordinary commands break
  // without them (e.g. `2>/dev/null`).
  const deviceWrite = `(allow file-write* ${STANDARD_DEVICE_WRITE_PATHS.map(literal).join(" ")} ${subpath("/dev/fd")})`;

  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow sysctl-read)",
    // ioctl on terminals: ttys/pipes need it for size queries, raw mode,
    // isatty() — harmless and unrelated to filesystem write-escape.
    "(allow file-ioctl)",
    "(allow file-read*)",
    writableSubpaths ? `(allow file-write* ${writableSubpaths})` : "",
    denyWriteSubpaths ? `(deny file-write* ${denyWriteSubpaths})` : "",
    deviceWrite,
    networkAllowAll
      ? "(allow network*)"
      : "(deny network-outbound) (allow network-bind (local ip)) (allow network* (local ip))",
  ].filter(Boolean);

  return lines.join("\n");
}
