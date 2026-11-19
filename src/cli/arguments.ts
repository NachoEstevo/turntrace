export function integer(name: string, value: string | boolean | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} must be a nonnegative safe integer.`);
  }
  return Number(value);
}

export function oneFile(paths: string[], command: string): string {
  if (paths.length !== 1 || !paths[0]) throw new Error(`Expected one input file for turntrace ${command}.`);
  return paths[0];
}

export function checkPath(flag: string, value: string | undefined): void {
  if (value !== undefined && !value.trim()) throw new Error(`--${flag} requires a path.`);
}
