import { main } from "./cli.ts";
import { exitAfterFlush } from "./exit.ts";
import { adoptEarlierEnvNames } from "../shared/env-names.ts";
// The sentinel, run from here, reads the server's own lines back in every language it writes them in.
import "./server-line-packs.ts";

// Before anything reads a setting: a deployment configured under the earlier names keeps working.
adoptEarlierEnvNames();

main().then(exitAfterFlush, (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  exitAfterFlush(1);
});
