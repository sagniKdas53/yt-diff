import { config } from "../../config.ts";
import { logger } from "../../logger.ts";
import type {
  DownloadProcessEntry,
  ListingProcessEntry,
  ProcessLike,
} from "./types.ts";

export function urlToTitle(url: string) {
  try {
    const pathSegments = new URL(url).pathname.split("/");
    const unwantedSegments = new Set(["videos", "channel", "user", "playlist"]);
    const titleSegments = pathSegments.filter((segment) =>
      segment && !unwantedSegments.has(segment.toLowerCase())
    );
    return titleSegments.join("_") || url;
  } catch (error) {
    logger.error("Failed to generate title from URL", {
      url,
      error: (error as Error).message,
    });
    return url;
  }
}

export function truncateText(text: string, maxLength: number) {
  if (!text || typeof text !== "string") {
    logger.warn("Invalid text provided for truncation", {
      text,
      type: typeof text,
    });
    return "";
  }
  if (text.length <= maxLength) {
    return text;
  }
  const truncated = text.slice(0, maxLength);
  logger.debug(
    `Truncated text from ${text.length} to ${truncated.length} characters`,
  );
  return truncated;
}

export function getProcessStates(processMap: Map<string, ProcessLike>) {
  const states = new Map<
    string,
    { status: string; type: string; lastActive: number }
  >();
  for (const [processId, process] of processMap.entries()) {
    states.set(processId, {
      status: process.status,
      type: process.spawnType,
      lastActive: process.lastActivity,
    });
  }
  return JSON.stringify(Object.fromEntries(states));
}

export function cleanupStaleProcesses(
  processMap: Map<string, ProcessLike>,
  {
    maxIdleTime = config.queue.maxIdle,
    maxLifetime = config.queue.maxLifetime,
    forceKill = false,
  } = {},
  processType: string,
) {
  const now = Date.now();
  let cleanedCount = 0;

  logger.info(
    `Cleaning up processes older than ${
      maxIdleTime / 1000
    } seconds in ${processType} processes`,
  );
  logger.trace("Current process states:", {
    states: getProcessStates(processMap),
  });

  for (const [processId, process] of processMap.entries()) {
    const {
      status,
      lastActivity,
      lastStdoutActivity,
      spawnTimeStamp,
      spawnedProcess,
    } = process;

    const age = now - spawnTimeStamp;
    const idleTime = now - lastActivity;
    const stdoutIdleTime = lastStdoutActivity ? now - lastStdoutActivity : age;
    const isErrorOnly = lastStdoutActivity &&
      (lastActivity > lastStdoutActivity) && (stdoutIdleTime > maxIdleTime);

    if (status === "completed" || status === "failed") {
      processMap.delete(processId);
      cleanedCount++;
      continue;
    }

    if (
      status === "running" &&
      (idleTime > maxIdleTime || age > maxLifetime || isErrorOnly)
    ) {
      const isActivelyProducingData = lastStdoutActivity &&
        (now - lastStdoutActivity < maxIdleTime);
      if (
        processType === "list" && isActivelyProducingData &&
        !(idleTime > maxIdleTime) && !isErrorOnly
      ) {
        logger.info(
          `Skipping cleanup for active list process ${processId} (age: ${
            Math.round(age / 1000)
          }s, last stdout: ${
            Math.round((now - lastStdoutActivity) / 1000)
          }s ago)`,
        );
        continue;
      }

      if (spawnedProcess?.kill && forceKill) {
        try {
          const killed = spawnedProcess.kill("SIGKILL");
          if (!killed) {
            const terminated = spawnedProcess.kill("SIGTERM");
            if (!terminated) {
              throw new Error("Failed to terminate process");
            }
          }
        } catch (error) {
          logger.error(`Failed to kill process ${processId}`, {
            error: (error as Error).message,
          });
        }
      }

      processMap.delete(processId);
      cleanedCount++;
    }
  }

  logger.info(`Cleaned up ${cleanedCount} processes`);
  logger.trace("Updated process states:", {
    states: getProcessStates(processMap),
  });

  return cleanedCount;
}

export function createProcessManager(
  downloadProcesses: Map<string, DownloadProcessEntry>,
  listProcesses: Map<string, ListingProcessEntry>,
) {
  function updateProcessActivity(processKey: string, isStdout = false) {
    const downloadEntry = downloadProcesses.get(processKey);
    if (downloadEntry) {
      const now = Date.now();
      downloadEntry.lastActivity = now;
      if (isStdout) {
        downloadEntry.lastStdoutActivity = now;
      }
    }

    const listEntry = listProcesses.get(processKey);
    if (listEntry) {
      const now = Date.now();
      listEntry.lastActivity = now;
      if (isStdout) {
        listEntry.lastStdoutActivity = now;
      }
    }
  }

  function cleanupProcess(processKey: string, pid: number | undefined) {
    if (downloadProcesses.has(processKey)) {
      downloadProcesses.delete(processKey);
      logger.trace(`Removed process from cache: ${pid}`, { pid });
      logger.trace(`Process map state: ${getProcessStates(downloadProcesses)}`);
      logger.trace(`Process map size: ${downloadProcesses.size}`);
    }
  }

  return { updateProcessActivity, cleanupProcess };
}
