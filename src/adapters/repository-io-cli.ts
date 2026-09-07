import { Socket } from "node:net";
import { StateStore } from "./store.js";
import { PublicationGit } from "./publication-git.js";
import { readRepositoryIORequest, superviseRepositoryIO } from "./repository-io.js";
import { digestJson } from "../domain/repository-policy.js";
import { redactSensitiveText } from "../util/redact.js";

/** Entire Git effect and every prepared-ref guard execute inside the supervised namespace. */
async function work() {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  const { record, authority } = await readRepositoryIORequest(input);
  input.destroy();
  const store = new StateStore(record.stateFile.path, record.stateFile);
  try {
    const phase = record.phase;
    if (phase !== "acquiring" && phase !== "releasing")
      throw new Error("Invalid repository operation");
    const guard = async () => {
      if (digestJson(store.storageIdentity()) !== digestJson(record.stateFile))
        throw new Error("Repository worker state identity changed");
      store.orchestration.repositoryAdmission.assertIO(authority, record.ioId!, phase);
      const retained = store.orchestration.repositoryAdmission.record(authority.runId);
      if (digestJson(retained) !== digestJson(record))
        throw new Error("Repository worker intent changed");
      if (
        phase === "releasing" &&
        store.orchestration.control(authority.runId).status !== "complete"
      )
        throw new Error("Run completion changed before ownership release");
    };
    await guard();
    const git = new PublicationGit("run"),
      signal = new AbortController().signal;
    if (phase === "acquiring")
      await git.acquireLock(
        record.repository,
        record.revision,
        record.objectContent,
        guard,
        signal,
      );
    else await git.releaseLock(record.repository, record.revision, guard, signal);
  } finally {
    store.close();
  }
}

const mode = process.argv[2];
(mode === "supervise"
  ? superviseRepositoryIO()
  : mode === "work"
    ? work()
    : Promise.reject(new Error("Invalid repository I/O entrypoint"))
).catch((error: unknown) => {
  process.stderr.write(
    `${redactSensitiveText(error instanceof Error ? error.message : "Repository I/O failed")}\n`,
  );
  process.exitCode = 1;
});
