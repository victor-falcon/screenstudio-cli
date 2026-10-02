export function numberValue(value: string, name: string, min = 0, max = Infinity): number {
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result) || result < min || result > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return result;
}

export function indexValue(value: string, name = "Slice index"): number {
  const result = numberValue(value, name);
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer.`);
  return result;
}

export function timeRange(start: number, end: number): void {
  if (end <= start) throw new Error("End time must be greater than start time.");
}

export function choiceValue<T extends string>(value: string, name: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error(`${name} must be one of: ${choices.join(", ")}.`);
  return value as T;
}
