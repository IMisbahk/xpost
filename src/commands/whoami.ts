import { getXApiClient } from "../xapi/factory.js";
import { emitSuccess, type OutputMode } from "../lib/output.js";

export async function cmdWhoami(mode: OutputMode): Promise<void> {
  const client = await getXApiClient();
  const user = await client.verifyCredentials();
  emitSuccess(mode, { handle: user.username, id: user.id }, [
    `@${user.username}`,
  ]);
}
