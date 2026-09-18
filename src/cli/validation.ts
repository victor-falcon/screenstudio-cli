export function numberValue(value: string, name: string, min = 0, max = Infinity): number {
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return result;
}

export function indexValue(value: string): number {
  const result = numberValue(value, "Slice index");
  if (!Number.isInteger(result)) throw new Error("Slice index must be an integer.");
  return result;
}

export function timeRange(start: number, end: number): void {
  if (end <= start) throw new Error("End time must be greater than start time.");
}

// Screen Studio leaves $project pointing at the last editor after it closes.
export const PROJECT_LOOKUP = `
  var p = window.$project;
  if (p && typeof window.$projects?.values === 'function' &&
      !Array.from(window.$projects.values()).includes(p)) p = null;
`;

export const PROJECT = `${PROJECT_LOOKUP}
  if (!p) throw new Error('No project open');
`;

export const SCENE = `${PROJECT}
  var scene = p.scenes[0];
  if (!scene) throw new Error('No scene');
`;
