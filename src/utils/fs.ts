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

export async function exists(filePath: string): Promise<boolean> {
  try {
    await Deno.stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/**
 * True when the path exists *and* is a regular file.
 *
 * `exists` is not enough for anything that will later be opened and streamed:
 * `Deno.stat` succeeds on a directory, so a signed URL could be minted for one
 * and the serve path would then send a Content-Length taken from the directory
 * entry before failing EISDIR partway through the body.
 */
export async function isFile(targetPath: string): Promise<boolean> {
  try {
    return (await Deno.stat(targetPath)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

export async function readdir(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dirPath)) {
    files.push(entry.name);
  }
  return files;
}

export async function mkdir(
  dirPath: string,
  options?: { recursive?: boolean },
): Promise<void> {
  await Deno.mkdir(dirPath, { recursive: options?.recursive });
}

export async function rm(
  targetPath: string,
  options?: { recursive?: boolean; force?: boolean },
): Promise<void> {
  try {
    await Deno.remove(targetPath, { recursive: options?.recursive });
  } catch (error) {
    if (
      options?.force && error instanceof Deno.errors.NotFound
    ) {
      return;
    }
    throw error;
  }
}

export async function unlink(filePath: string): Promise<void> {
  await Deno.remove(filePath);
}
