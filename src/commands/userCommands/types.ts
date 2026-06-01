/**
 * User-defined slash command type definitions (stage 23).
 *
 * A "user command" is a Markdown file with optional YAML frontmatter that
 * the USER invokes by name (`/review src/foo.ts`). It's the user-triggered
 * sibling of a Skill (model-triggered). The body is a prompt template whose
 * `$ARGUMENTS` / `$1` placeholders are filled in at invocation time and then
 * submitted as a normal chat turn.
 *
 * Reference: claude-code-source-code/src/utils/markdownConfigLoader.ts
 *   (commands live in the `commands` config dir) +
 *   src/utils/argumentSubstitution.ts.
 */

export type UserCommandSource = "user" | "project";

export interface UserCommand {
  /**
   * Command name as typed after the slash. Subdirectories become a `:`
   * namespace, so `team/review.md` → `team:review` (invoked `/team:review`).
   */
  name: string;
  /** One-line description for the suggestion list + `/help`. */
  description: string;
  /** Optional UI hint for arguments (e.g. `<file-or-dir>`). */
  argumentHint?: string;
  /** Optional model override applied for this turn only. */
  model?: string;
  /** Tool whitelist added to session-allow rules when the command runs. */
  allowedTools: string[];
  /** Prompt template (markdown body, frontmatter stripped). */
  body: string;
  /** Absolute path to the source `.md` file. */
  filePath: string;
  /** Where this command came from. Project overrides user. */
  source: UserCommandSource;
}
