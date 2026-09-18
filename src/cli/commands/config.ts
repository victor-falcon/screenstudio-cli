import { Command } from "commander";
import { withClient } from "../../cdp/client.js";
import { output } from "../format.js";
import { PROJECT } from "../validation.js";

export function configPatchExpression(changes: Record<string, unknown>): string {
  const serialized = JSON.stringify(changes, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Config numbers must be finite.");
    return value;
  });
  return `${PROJECT}
    var changes = JSON.parse(${JSON.stringify(serialized)});
    for (var key of Object.keys(changes)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) ||
          !Object.prototype.hasOwnProperty.call(p.config, key)) {
        throw new Error('Unknown config key: ' + key + '. Run screenstudio config --list.');
      }
      var current = p.config[key], next = changes[key];
      if (current !== null && next !== null &&
          (typeof current !== typeof next || Array.isArray(current) !== Array.isArray(next))) {
        throw new Error('Invalid value type for config key: ' + key);
      }
    }
    if (typeof p.updateConfig !== 'function') throw new Error('This Screen Studio build does not expose config editing.');
    p.updateConfig(changes);
    return Object.fromEntries(Object.keys(changes).map(function(key) { return [key, p.config[key]]; }));
  `;
}

export const configCommand = new Command("config")
  .description("Read or write config keys exposed by the connected Screen Studio version")
  .argument("[key]", "Config key to read or write")
  .argument("[value]", "Value to set (string or JSON)")
  .option("--list", "List all config keys and values")
  .action(async (key, value, opts, cmd) => {
    const port = Number(cmd.optsWithGlobals().port || "9222");
    const json = cmd.optsWithGlobals().json || false;
    const result = await withClient(port, async (client) => {
      if (opts.list || !key) return client.evaluate(`${PROJECT} return p.config;`);
      if (value === undefined) return client.evaluate(`${PROJECT}
        var key = ${JSON.stringify(key)};
        if (!Object.prototype.hasOwnProperty.call(p.config, key)) throw new Error('Unknown config key: ' + key);
        return p.config[key];
      `);
      let parsed: unknown = value;
      try { parsed = JSON.parse(value); } catch { /* Keep plain strings. */ }
      const values = await client.evaluate<Record<string, unknown>>(configPatchExpression({ [key]: parsed }));
      return { key, value: values[key] };
    });
    output(result, json);
  });
