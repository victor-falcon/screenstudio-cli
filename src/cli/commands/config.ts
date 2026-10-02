import { Command } from "commander";
import { evaluate, globals } from "../context.js";
import { output } from "../format.js";

// Screen Studio 4 groups the project config (captions.*, audio.*, cursor.*...). Keys that
// were renamed when 3.x's flat config was grouped; same-named keys are found automatically.
const RENAMED_KEYS: Record<string, string> = {
  showTranscript: "captions.enableTranscript",
  transcriptSizeRatio: "captions.sizeRatio",
  showShortcuts: "captions.enableShortcuts",
  audioVolume: "audio.volume",
  hideCamera: "camera.hide",
  cursorSet: "cursor.set",
  deviceFrameKey: "device.frameKey",
};

// Defines config, own, get and unknown for the expressions below.
const CONFIG_HELPERS = `
  var p = ss.project(), config = p.projectConfig.serialize();
  var renamed = ${JSON.stringify(RENAMED_KEYS)};
  var own = function (o, k) { return o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); };
  var get = function (o, parts) { return parts.reduce(function (v, k) { return own(v, k) ? v[k] : undefined; }, o); };
  var suggest = function (key) {
    if (renamed[key]) return renamed[key];
    for (var group of Object.keys(config)) if (own(config[group], key)) return group + '.' + key;
    return null;
  };
  var unknown = function (path, parent) {
    var hint = path.indexOf('.') < 0 ? suggest(path) : null;
    var keys = parent && typeof parent === 'object' ? Object.keys(parent).join(', ') : '';
    return new Error('Unknown config key: ' + path + '.' + (hint ? ' Did you mean ' + hint + '?' : '') +
      (keys ? ' Available here: ' + keys + '.' : '') + ' Run screenstudio config --flat.');
  };
  var resolvePath = function (path) {
    var parts = path.split('.');
    if (parts.some(function (k) { return !k || ['__proto__', 'constructor', 'prototype'].includes(k); })) throw unknown(path);
    if (parts.length < 2) throw unknown(path, config);
    var parent = get(config, parts.slice(0, -1)), last = parts[parts.length - 1];
    if (!own(parent, last)) throw unknown(path, parent);
    return { parts: parts, parent: parent, last: last };
  };
`;

// Validates dot paths against the serialized config and writes one partial update per
// group, which the app records as a single undo step.
export function configPatchExpression(changes: Record<string, unknown>): string {
  const serialized = JSON.stringify(changes, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Config numbers must be finite.");
    return value;
  });
  return `${CONFIG_HELPERS}
    var changes = JSON.parse(${JSON.stringify(serialized)}), patch = {};
    for (var path of Object.keys(changes)) {
      var resolved = resolvePath(path), parts = resolved.parts, parent = resolved.parent, last = resolved.last;
      var current = parent[last], next = changes[path];
      if (current !== null && next !== null &&
          (typeof current !== typeof next || Array.isArray(current) !== Array.isArray(next))) {
        throw new Error('Invalid value type for config key ' + path + ': expected ' + (Array.isArray(current) ? 'array' : typeof current) + '.');
      }
      var group = parts[0], key = parts[1];
      patch[group] = patch[group] || {};
      if (parts.length === 2) { patch[group][key] = next; continue; }
      var value = own(patch[group], key) ? patch[group][key] : JSON.parse(JSON.stringify(config[group][key]));
      var node = value;
      for (var i = 2; i < parts.length - 1; i++) node = node[parts[i]];
      node[last] = next;
      patch[group][key] = value;
    }
    if (typeof p.updateConfig !== 'function') throw new Error('This Screen Studio build does not expose config editing.');
    p.updateConfig(patch);
    var after = p.projectConfig.serialize();
    return Object.fromEntries(Object.keys(changes).map(function (path) { return [path, get(after, path.split('.'))]; }));
  `;
}

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

export const configCommand = new Command("config")
  .description("Read or write project config by path, e.g. captions.enableTranscript")
  .argument("[path]", "Config path to read or write (group.key[.subkey])")
  .argument("[value]", "Value to set (JSON, or a plain string)")
  .option("--list", "Print the whole config")
  .option("--flat", "Print every config path and its value")
  .action(async (path, value, opts, cmd) => {
    const json = globals(cmd).json;
    if (opts.list || opts.flat || !path) {
      const config = await evaluate<Record<string, unknown>>(cmd, `return ss.project().projectConfig.serialize();`);
      if (!opts.flat) return output(config, json);
      const flat = flatten(config);
      if (json) return output(flat, true);
      for (const [key, v] of Object.entries(flat)) console.log(`${key} = ${JSON.stringify(v)}`);
      return;
    }
    if (value === undefined) {
      const result = await evaluate<{ value: unknown }>(cmd, `${CONFIG_HELPERS}
        var resolved = resolvePath(${JSON.stringify(path)});
        return { value: resolved.parent[resolved.last] };
      `);
      return output(result.value, json);
    }
    let parsed: unknown = value;
    try { parsed = JSON.parse(value); } catch { /* Keep plain strings. */ }
    const values = await evaluate<Record<string, unknown>>(cmd, configPatchExpression({ [path]: parsed }));
    output({ key: path, value: values[path] }, json);
  });
