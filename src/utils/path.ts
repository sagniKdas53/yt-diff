export const sep = "/";

function splitSegments(value: string): string[] {
  return value.split("/").filter((segment) => segment.length > 0);
}

function normalizeSegments(segments: string[], absolute: boolean): string[] {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== "..") {
        normalized.pop();
      } else if (!absolute) {
        normalized.push("..");
      }
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

export function isAbsolute(value: string): boolean {
  return value.startsWith("/");
}

export function normalize(value: string): string {
  if (value === "") {
    return ".";
  }
  const absolute = isAbsolute(value);
  const normalized = normalizeSegments(splitSegments(value), absolute).join("/");
  if (absolute) {
    return normalized ? `/${normalized}` : "/";
  }
  return normalized || ".";
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) {
    return ".";
  }
  return normalize(filtered.join("/"));
}

export function resolve(...parts: string[]): string {
  let resolved = "";
  for (const part of parts) {
    if (!part) continue;
    if (isAbsolute(part)) {
      resolved = part;
    } else {
      resolved = resolved ? `${resolved}/${part}` : `${Deno.cwd()}/${part}`;
    }
  }
  if (!resolved) {
    resolved = Deno.cwd();
  }
  return normalize(resolved);
}

export function basename(value: string): string {
  const normalized = normalize(value);
  if (normalized === "/") {
    return "/";
  }
  const segments = splitSegments(normalized);
  return segments[segments.length - 1] || "";
}

export function extname(value: string): string {
  const base = basename(value);
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) {
    return "";
  }
  return base.slice(lastDot);
}

export function relative(from: string, to: string): string {
  const fromResolved = resolve(from);
  const toResolved = resolve(to);
  const fromSegments = splitSegments(fromResolved);
  const toSegments = splitSegments(toResolved);

  let shared = 0;
  while (
    shared < fromSegments.length &&
    shared < toSegments.length &&
    fromSegments[shared] === toSegments[shared]
  ) {
    shared++;
  }

  const up = new Array(fromSegments.length - shared).fill("..");
  const down = toSegments.slice(shared);
  const result = [...up, ...down].join("/");
  return result || ".";
}

export function isWithinPath(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  return childResolved === parentResolved ||
    childResolved.startsWith(`${parentResolved}/`);
}
