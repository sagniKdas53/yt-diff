export function existsSync(filePath: string): boolean {
  try {
    Deno.statSync(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export function readFileSync(filePath: string): Uint8Array {
  return Deno.readFileSync(filePath);
}

export function readTextFileSync(filePath: string): string {
  return Deno.readTextFileSync(filePath);
}

export function mkdirSync(
  dirPath: string,
  options?: { recursive?: boolean },
): void {
  Deno.mkdirSync(dirPath, { recursive: options?.recursive });
}

export function rmSync(
  targetPath: string,
  options?: { recursive?: boolean; force?: boolean },
): void {
  try {
    Deno.removeSync(targetPath, { recursive: options?.recursive });
  } catch (error) {
    if (
      options?.force && error instanceof Deno.errors.NotFound
    ) {
      return;
    }
    throw error;
  }
}

export function unlinkSync(filePath: string): void {
  Deno.removeSync(filePath);
}

export function readdirSync(dirPath: string): string[] {
  return Array.from(Deno.readDirSync(dirPath), (entry) => entry.name);
}

export function statSync(targetPath: string): Deno.FileInfo {
  return Deno.statSync(targetPath);
}

export async function stat(targetPath: string): Promise<Deno.FileInfo> {
  return await Deno.stat(targetPath);
}
