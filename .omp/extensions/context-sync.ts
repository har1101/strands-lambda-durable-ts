/**
 * context-sync: before the main session settles, ask the agent to record progress, handoff notes, and
 * learnings under docs/context/ and push them, whenever the repository has work that is newer than the
 * last docs/context commit.
 *
 * Uses the omp `session_stop` event (main session only; subagents never trigger it), so it applies to
 * whichever model runs in omp. Set OMP_CONTEXT_SYNC=0 to disable it for a session.
 * Conventions for the files are in docs/context/README.md.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const CONTEXT_DIR = "docs/context";
const TIME_ZONE = process.env.OMP_CONTEXT_SYNC_TZ ?? "Asia/Tokyo";

export default function contextSync(pi: ExtensionAPI): void {
  // Work state (latest non-context commit plus uncommitted changes) at the last request, so the same work
  // is not requested twice: neither after a docs-only commit nor after the agent answers "no update needed".
  let promptedFor: string | undefined;

  pi.on("session_stop", async (_event, ctx) => {
    if (process.env.OMP_CONTEXT_SYNC === "0") return;
    const git = async (...args: string[]) => {
      const result = await pi.exec("git", args, { cwd: ctx.cwd, timeout: 15_000 });
      return result.code === 0 ? result.stdout.trim() : undefined;
    };
    if (!(await git("rev-parse", "--show-toplevel"))) return;

    const outside = [".", `:(exclude)${CONTEXT_DIR}`];
    const lastContextCommit = await git("log", "-1", "--format=%H", "--", CONTEXT_DIR);
    const newCommits = await git("rev-list", "--count", lastContextCommit ? `${lastContextCommit}..HEAD` : "HEAD", "--", ...outside);
    const dirty = (await git("status", "--porcelain", "--", ...outside)) ?? "";
    if (Number(newCommits ?? 0) === 0 && !dirty) return;

    const lastWorkCommit = await git("log", "-1", "--format=%H", "--", ...outside);
    const diff = dirty ? ((await git("diff", "HEAD", "--", ...outside)) ?? "") : "";
    const workState = `${lastWorkCommit}\n${dirty}\n${diff}`;
    if (workState === promptedFor) return;
    promptedFor = workState;

    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: TIME_ZONE }).format(new Date());
    return {
      continue: true,
      additionalContext: [
        `[context-sync] This repository has work that is not yet reflected in ${CONTEXT_DIR}/.`,
        `Before finishing, follow ${CONTEXT_DIR}/README.md:`,
        `1. Create or update ${CONTEXT_DIR}/${today}-handoff.md (current status, progress, open decisions, next steps, handoff notes) and ${CONTEXT_DIR}/${today}-learnings.md (lessons learned in this session). Start from the latest earlier files in ${CONTEXT_DIR}/, keep facts that still hold, and write in Japanese.`,
        `2. Commit only ${CONTEXT_DIR}/ (git add ${CONTEXT_DIR}; message "docs(context): ${today} handoff and learnings") and push the current branch.`,
        "If there is nothing worth recording (for example, only exploratory commands), reply briefly that no update is needed and finish.",
      ].join("\n"),
    };
  });
}
