import type { Command } from "commander";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { withClient } from "../cdp/client.js";
import { runtimePrelude } from "../cdp/runtime.js";

export interface GlobalOptions {
  port: number;
  json: boolean;
  project?: string;
}

export function globals(cmd: Command): GlobalOptions {
  const opts = cmd.optsWithGlobals();
  const port = Number(opts.port ?? 9222);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CDP port must be an integer from 1 to 65535.");
  }
  return { port, json: !!opts.json, project: projectSelector(opts.project) };
}

// Screen Studio reports real paths (/private/tmp, not /tmp), so resolve existing paths.
function projectSelector(value?: string): string | undefined {
  if (!value) return undefined;
  const path = resolve(value);
  return existsSync(path) ? realpathSync(path) : value;
}

// Runs `body` in Screen Studio's main window after the runtime prelude, which defines
// `ss` (see cdp/runtime.ts). The body may await and must return JSON-serializable data.
export function evaluate<T = unknown>(cmd: Command, body: string, timeoutMs?: number): Promise<T> {
  const { port, project } = globals(cmd);
  return withClient(port, client => client.evaluate<T>(`${runtimePrelude(project)}\n${body}`), undefined, timeoutMs);
}
