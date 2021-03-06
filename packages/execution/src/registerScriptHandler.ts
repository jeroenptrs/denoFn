import {
  logger,
  proxy,
  proxyUrl,
  RegistryJSONInternal,
  Request,
  Response,
  Router,
  UUID,
} from "../deps.ts";
import * as c from "./constants.ts";
import * as db from "./db.ts";
import { spawn } from "./spawn.ts";
import { waitAndCheckHasBeenWarmedUp } from "./warmup.ts";

export const registerScriptHandler = (app: Router) => (registry: RegistryJSONInternal) => {
  const { name: scriptName, port } = registry;
  app.use(`${scriptName}`, async (req: Request, _res: Response) => {
    let lockStart;
    const lock = UUID.generate();
    const has = db.has(scriptName);

    if (!has || (has && !db.get(scriptName)?.process)) {
      lockStart = await scenario1(registry, lock);
    } else if (has && !db.get(scriptName)?.process && db.isLocked(scriptName)) {
      await scenario2(scriptName);
    }

    if (!lockStart) db.createLock(scriptName, lock);

    const newStarted = Date.now();
    const res = await proxy(proxyUrl(port))(req, _res);

    db.freeLock(scriptName, lock, newStarted, lockStart);

    return res;
  });
};

/**
 * Lambda starts - 2 scenarios:
 * 1) no db entry/no active process: lock FIRST -> spawn -> warm up -> do stuff -> free lock
 * 2) no active process but is locked already (this is why we lock FIRST in 1!): wait till warmed up -> then lock -> do stuff -> free lock
 */

export async function scenario1(registry: RegistryJSONInternal, lock: string) {
  db.createLock(registry.name, lock); // Also creates entry if non-existent
  const lockStart = Date.now();

  const { name: scriptName } = registry;
  logger.system("Execution", `Spawning new ${scriptName} instance`, "file");

  const {
    pid: process,
    rid: resource,
    stdout,
  }: Deno.Process<{ cmd: string[]; stdout: "piped" }> = await spawn(registry);
  stdout.close();

  db.set(scriptName, { process, resource, started: Date.now(), warmedUp: true });

  return lockStart;
}

async function scenario2(scriptName: string) {
  const waitCheck = waitAndCheckHasBeenWarmedUp(c.TIMEOUT_INCREMENT, scriptName);

  let a = await waitCheck();
  while (!a) {
    a = await waitCheck();
  }
}
