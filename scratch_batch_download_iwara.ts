const STATE_FILE = "iwara_batch_state.json";
const FAILED_FILE = "iwara_failed_urls.json";
const BATCH_SIZE = 10;
const URL_BASE = Deno.env.get("URL_BASE") ?? "/ytdiff";
const SOCKET_PATH = `${URL_BASE}/socket.io/`;
const DOWNLOAD_PATH = `${URL_BASE}/download`;
const BATCH_TIMEOUT_MS = Number(
  Deno.env.get("IWARA_BATCH_TIMEOUT_MS") ?? 60 * 60 * 1000,
);

interface InputEntry {
  playlistUrl: string;
  videoUrl: string;
}

interface BatchPayload {
  playListUrl: string;
  urlList: string[];
}

interface DownloadStartedEvent {
  url?: string;
  percentage?: number;
}

interface DownloadDoneEvent {
  url?: string;
  title?: string;
  fileName?: string | null;
  saveDirectory?: string;
  isMetaDataSynced?: boolean;
  thumbNailFile?: string | null;
  subTitleFile?: string | null;
  descriptionFile?: string | null;
}

interface DownloadFailedEvent {
  url?: string;
  title?: string;
}

interface SuccessRecord {
  batchIndex: number;
  batchNumber: number;
  playlistUrl: string;
  videoUrl: string;
  title: string | null;
  fileName: string | null;
  completedAt: string;
}

interface FailureRecord {
  batchIndex: number;
  batchNumber: number;
  playlistUrl: string;
  videoUrl: string;
  title: string | null;
  failedAt: string;
  reason: string;
  phase: "queue" | "download" | "timeout";
  attempt: number;
}

interface BatchStateSnapshot {
  batchIndex: number;
  batchNumber: number;
  playlistUrl: string;
  totalUrls: number;
  queuedUrls: number;
  batchStatus:
    | "waiting-for-queue"
    | "running"
    | "completed"
    | "interrupted"
    | "timed-out";
  startedAt: string;
  lastEventAt: string;
  pendingUrls: string[];
  startedUrls: string[];
  successfulDownloads: SuccessRecord[];
  failedDownloads: FailureRecord[];
}

interface ScriptState {
  fileToRead: string;
  batchSize: number;
  totalBatches: number;
  lastProcessedBatchIndex: number;
  lastQueuedBatchIndex: number | null;
  updatedAt: string;
  lastSuccess: SuccessRecord | null;
  totals: {
    batchesCompleted: number;
    successes: number;
    failures: number;
  };
  currentBatch: BatchStateSnapshot | null;
}

interface BatchTracker {
  batchIndex: number;
  batchNumber: number;
  batch: BatchPayload;
  allUrls: string[];
  pendingUrls: Set<string>;
  startedUrls: Set<string>;
  successfulDownloads: Map<string, SuccessRecord>;
  failedDownloads: Map<string, FailureRecord>;
  startedAt: string;
  lastEventAt: string;
  batchStatus: BatchStateSnapshot["batchStatus"];
  completionPromise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

function nowIso() {
  return new Date().toISOString();
}

function pathExists(path: string) {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

function readJsonFile<T>(path: string): T | null {
  if (!pathExists(path)) {
    return null;
  }

  try {
    return JSON.parse(Deno.readTextFileSync(path)) as T;
  } catch (error) {
    console.warn(`Could not parse ${path}: ${(error as Error).message}`);
    return null;
  }
}

function writeJsonFile(path: string, data: unknown) {
  Deno.writeTextFileSync(path, JSON.stringify(data, null, 2));
}

function createEmptyState(
  fileToRead: string,
  totalBatches: number,
): ScriptState {
  return {
    fileToRead,
    batchSize: BATCH_SIZE,
    totalBatches,
    lastProcessedBatchIndex: 0,
    lastQueuedBatchIndex: null,
    updatedAt: nowIso(),
    lastSuccess: null,
    totals: {
      batchesCompleted: 0,
      successes: 0,
      failures: 0,
    },
    currentBatch: null,
  };
}

function loadState(fileToRead: string, totalBatches: number): ScriptState {
  const fallback = createEmptyState(fileToRead, totalBatches);
  const parsed = readJsonFile<Partial<ScriptState>>(STATE_FILE);

  if (!parsed) {
    return fallback;
  }

  return {
    fileToRead,
    batchSize: BATCH_SIZE,
    totalBatches,
    lastProcessedBatchIndex: typeof parsed.lastProcessedBatchIndex === "number"
      ? parsed.lastProcessedBatchIndex
      : 0,
    lastQueuedBatchIndex: typeof parsed.lastQueuedBatchIndex === "number"
      ? parsed.lastQueuedBatchIndex
      : null,
    updatedAt: typeof parsed.updatedAt === "string"
      ? parsed.updatedAt
      : nowIso(),
    lastSuccess: parsed.lastSuccess ?? null,
    totals: {
      batchesCompleted:
        parsed.totals && typeof parsed.totals.batchesCompleted === "number"
          ? parsed.totals.batchesCompleted
          : 0,
      successes: parsed.totals && typeof parsed.totals.successes === "number"
        ? parsed.totals.successes
        : 0,
      failures: parsed.totals && typeof parsed.totals.failures === "number"
        ? parsed.totals.failures
        : 0,
    },
    currentBatch: parsed.currentBatch ?? null,
  };
}

function saveState(state: ScriptState) {
  state.updatedAt = nowIso();
  writeJsonFile(STATE_FILE, state);
}

function loadFailures(): FailureRecord[] {
  const parsed = readJsonFile<FailureRecord[]>(FAILED_FILE);
  return Array.isArray(parsed) ? parsed : [];
}

function appendFailures(
  failures: FailureRecord[],
  newFailures: FailureRecord[],
) {
  failures.push(...newFailures);
  writeJsonFile(FAILED_FILE, failures);
}

function buildBatches(data: InputEntry[]): BatchPayload[] {
  const byPlaylist: Record<string, string[]> = {};

  for (const item of data) {
    if (!byPlaylist[item.playlistUrl]) {
      byPlaylist[item.playlistUrl] = [];
    }
    if (!byPlaylist[item.playlistUrl].includes(item.videoUrl)) {
      byPlaylist[item.playlistUrl].push(item.videoUrl);
    }
  }

  const batches: BatchPayload[] = [];
  for (const [playlistUrl, urls] of Object.entries(byPlaylist)) {
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      batches.push({
        playListUrl: playlistUrl,
        urlList: urls.slice(i, i + BATCH_SIZE),
      });
    }
  }

  return batches;
}

function createSocketUrl(host: string) {
  const url = new URL(host);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = SOCKET_PATH;
  url.search = "EIO=4&transport=websocket";
  return url.toString();
}

function createSocketClient(
  host: string,
  authToken: string,
  onEvent: (eventName: string, payload: unknown) => void,
) {
  const socketUrl = createSocketUrl(host);
  const ws = new WebSocket(socketUrl);

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let isReady = false;

  ws.onopen = () => {
    console.log(`Socket transport connected to ${socketUrl}`);
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== "string") {
      return;
    }

    const message = event.data;

    if (message === "2") {
      ws.send("3");
      return;
    }

    if (message.startsWith("0")) {
      ws.send(`40${JSON.stringify({ token: authToken })}`);
      return;
    }

    if (message === "40") {
      isReady = true;
      readyResolve();
      return;
    }

    if (message.startsWith("40")) {
      isReady = true;
      readyResolve();
      return;
    }

    if (message.startsWith("42")) {
      try {
        const [eventName, payload] = JSON.parse(message.slice(2)) as [
          string,
          unknown,
        ];

        if (eventName === "init" && payload && typeof payload === "object") {
          const id = (payload as { id?: string }).id ?? "";
          ws.send(`42${
            JSON.stringify(["acknowledge", {
              data: "Connected",
              id,
            }])
          }`);
        }

        onEvent(eventName, payload);
      } catch (error) {
        console.warn(
          `Failed to parse socket payload: ${(error as Error).message}`,
        );
      }
      return;
    }

    if (message.startsWith("44")) {
      const error = new Error(
        message.slice(2) || "Socket authentication failed",
      );
      if (!isReady) {
        readyReject(error);
      }
      return;
    }
  };

  ws.onerror = () => {
    if (!isReady) {
      readyReject(new Error("Socket connection failed"));
    }
  };

  ws.onclose = () => {
    if (!isReady) {
      readyReject(new Error("Socket closed before authentication completed"));
    }
  };

  return {
    ready,
    close() {
      ws.close();
    },
  };
}

function nextFailureAttempt(failures: FailureRecord[], videoUrl: string) {
  return failures.filter((entry) => entry.videoUrl === videoUrl).length + 1;
}

function serializeBatchTracker(tracker: BatchTracker): BatchStateSnapshot {
  return {
    batchIndex: tracker.batchIndex,
    batchNumber: tracker.batchNumber,
    playlistUrl: tracker.batch.playListUrl,
    totalUrls: tracker.allUrls.length,
    queuedUrls: tracker.pendingUrls.size + tracker.startedUrls.size +
      tracker.successfulDownloads.size + tracker.failedDownloads.size,
    batchStatus: tracker.batchStatus,
    startedAt: tracker.startedAt,
    lastEventAt: tracker.lastEventAt,
    pendingUrls: [...tracker.pendingUrls],
    startedUrls: [...tracker.startedUrls],
    successfulDownloads: [...tracker.successfulDownloads.values()],
    failedDownloads: [...tracker.failedDownloads.values()],
  };
}

function persistCurrentBatch(state: ScriptState, tracker: BatchTracker | null) {
  state.currentBatch = tracker ? serializeBatchTracker(tracker) : null;
  saveState(state);
}

function createBatchTracker(
  batch: BatchPayload,
  batchIndex: number,
  existingSuccesses: SuccessRecord[],
) {
  const batchNumber = batchIndex + 1;
  const successfulDownloads = new Map<string, SuccessRecord>();
  for (const success of existingSuccesses) {
    successfulDownloads.set(success.videoUrl, success);
  }

  const pendingUrls = new Set(
    batch.urlList.filter((url) => !successfulDownloads.has(url)),
  );

  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const completionPromise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const tracker: BatchTracker = {
    batchIndex,
    batchNumber,
    batch,
    allUrls: [...batch.urlList],
    pendingUrls,
    startedUrls: new Set<string>(),
    successfulDownloads,
    failedDownloads: new Map<string, FailureRecord>(),
    startedAt: nowIso(),
    lastEventAt: nowIso(),
    batchStatus: "waiting-for-queue",
    completionPromise,
    resolve,
    reject,
    timeoutId: setTimeout(() => {}, 0),
  };

  tracker.timeoutId = setTimeout(() => {
    tracker.reject(
      new Error(
        `Batch ${tracker.batchNumber} timed out after ${BATCH_TIMEOUT_MS}ms`,
      ),
    );
  }, BATCH_TIMEOUT_MS);

  if (pendingUrls.size === 0) {
    clearTimeout(tracker.timeoutId);
    tracker.batchStatus = "completed";
    queueMicrotask(() => tracker.resolve());
  }

  return tracker;
}

function clearBatchTrackerTimeout(tracker: BatchTracker | null) {
  if (tracker) {
    clearTimeout(tracker.timeoutId);
  }
}

function markBatchUrlStarted(
  tracker: BatchTracker,
  payload: DownloadStartedEvent,
) {
  const url = payload.url;
  if (!url || !tracker.pendingUrls.has(url)) {
    return;
  }

  tracker.pendingUrls.delete(url);
  tracker.startedUrls.add(url);
  tracker.lastEventAt = nowIso();
  tracker.batchStatus = "running";
  console.log(
    `  Started ${url} (${
      tracker.successfulDownloads.size + tracker.failedDownloads.size +
      tracker.startedUrls.size
    }/${tracker.allUrls.length})`,
  );
}

function finalizeBatchUrlSuccess(
  tracker: BatchTracker,
  payload: DownloadDoneEvent,
) {
  const url = payload.url;
  if (!url) {
    return null;
  }

  if (
    tracker.successfulDownloads.has(url) || tracker.failedDownloads.has(url)
  ) {
    return null;
  }

  if (!tracker.pendingUrls.has(url) && !tracker.startedUrls.has(url)) {
    return null;
  }

  tracker.pendingUrls.delete(url);
  tracker.startedUrls.delete(url);
  tracker.lastEventAt = nowIso();

  const success: SuccessRecord = {
    batchIndex: tracker.batchIndex,
    batchNumber: tracker.batchNumber,
    playlistUrl: tracker.batch.playListUrl,
    videoUrl: url,
    title: payload.title ?? null,
    fileName: payload.fileName ?? null,
    completedAt: tracker.lastEventAt,
  };

  tracker.successfulDownloads.set(url, success);
  console.log(
    `  Done ${url} (${
      tracker.successfulDownloads.size + tracker.failedDownloads.size
    }/${tracker.allUrls.length})`,
  );

  if (
    tracker.pendingUrls.size === 0 &&
    tracker.startedUrls.size === 0
  ) {
    tracker.batchStatus = "completed";
    clearBatchTrackerTimeout(tracker);
    tracker.resolve();
  }

  return success;
}

function finalizeBatchUrlFailure(
  tracker: BatchTracker,
  failures: FailureRecord[],
  payload: DownloadFailedEvent,
) {
  const url = payload.url;
  if (!url) {
    return null;
  }

  if (
    tracker.successfulDownloads.has(url) || tracker.failedDownloads.has(url)
  ) {
    return null;
  }

  if (!tracker.pendingUrls.has(url) && !tracker.startedUrls.has(url)) {
    return null;
  }

  tracker.pendingUrls.delete(url);
  tracker.startedUrls.delete(url);
  tracker.lastEventAt = nowIso();

  const failure: FailureRecord = {
    batchIndex: tracker.batchIndex,
    batchNumber: tracker.batchNumber,
    playlistUrl: tracker.batch.playListUrl,
    videoUrl: url,
    title: payload.title ?? null,
    failedAt: tracker.lastEventAt,
    reason: "download-failed",
    phase: "download",
    attempt: nextFailureAttempt(failures, url),
  };

  tracker.failedDownloads.set(url, failure);
  console.log(
    `  Failed ${url} (${
      tracker.successfulDownloads.size + tracker.failedDownloads.size
    }/${tracker.allUrls.length})`,
  );

  if (
    tracker.pendingUrls.size === 0 &&
    tracker.startedUrls.size === 0
  ) {
    tracker.batchStatus = "completed";
    clearBatchTrackerTimeout(tracker);
    tracker.resolve();
  }

  return failure;
}

function getResumeSuccesses(
  state: ScriptState,
  batchIndex: number,
) {
  if (
    state.currentBatch &&
    state.currentBatch.batchIndex === batchIndex &&
    state.currentBatch.batchStatus !== "completed"
  ) {
    return state.currentBatch.successfulDownloads;
  }

  return [];
}

function recordBatchInterrupt(
  state: ScriptState,
  tracker: BatchTracker | null,
) {
  if (!tracker) {
    return;
  }

  tracker.batchStatus = "interrupted";
  tracker.lastEventAt = nowIso();
  persistCurrentBatch(state, tracker);
}

function recordQueueFailures(
  tracker: BatchTracker,
  failures: FailureRecord[],
  reason: string,
) {
  const failedAt = nowIso();
  const queueFailures = [...tracker.pendingUrls].map((url) => ({
    batchIndex: tracker.batchIndex,
    batchNumber: tracker.batchNumber,
    playlistUrl: tracker.batch.playListUrl,
    videoUrl: url,
    title: null,
    failedAt,
    reason,
    phase: "queue" as const,
    attempt: nextFailureAttempt(failures, url),
  }));

  for (const failure of queueFailures) {
    tracker.failedDownloads.set(failure.videoUrl, failure);
  }

  tracker.pendingUrls.clear();
  tracker.startedUrls.clear();
  tracker.batchStatus = "interrupted";
  tracker.lastEventAt = failedAt;

  return queueFailures;
}

function markBatchTimeoutFailures(
  tracker: BatchTracker,
  failures: FailureRecord[],
) {
  const timedOutAt = nowIso();
  const newFailures: FailureRecord[] = [];

  for (const url of [...tracker.pendingUrls, ...tracker.startedUrls]) {
    const failure: FailureRecord = {
      batchIndex: tracker.batchIndex,
      batchNumber: tracker.batchNumber,
      playlistUrl: tracker.batch.playListUrl,
      videoUrl: url,
      title: null,
      failedAt: timedOutAt,
      reason: "batch-timeout",
      phase: "timeout",
      attempt: nextFailureAttempt(failures, url),
    };
    tracker.failedDownloads.set(url, failure);
    newFailures.push(failure);
  }

  tracker.pendingUrls.clear();
  tracker.startedUrls.clear();
  tracker.lastEventAt = timedOutAt;
  tracker.batchStatus = "timed-out";

  return newFailures;
}

async function run() {
  const fileToRead = Deno.args[0] || "iwara_videos_filtered.json";
  console.log(`Reading from ${fileToRead}...`);

  const authToken =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjFmYWZjYTQyLWZlNTUtNDM1ZC05YTVlLTBkMjA1YjcwNGY4OCIsImxhc3RQYXNzd29yZENoYW5nZVRpbWUiOiIyMDI1LTExLTEyVDA4OjE5OjA2LjEyMFoiLCJpYXQiOjE3ODAxNTUxMzIsImV4cCI6MTc4MjgzMzUzMn0.nHuW90IRlr6vJMue6cO4tJ1QEDp5187BxKwtu3osJoc";
  if (!authToken) {
    console.error(
      "AUTH_TOKEN is required so this script can authenticate both the download request and the Socket.IO watcher.",
    );
    Deno.exit(1);
  }

  let text: string;
  try {
    text = Deno.readTextFileSync(fileToRead);
  } catch {
    console.error(
      `Failed to read ${fileToRead}. Did you run scratch_export_iwara_videos.ts first?`,
    );
    Deno.exit(1);
  }

  const data = JSON.parse(text) as InputEntry[];
  const batches = buildBatches(data);
  console.log(
    `Created ${batches.length} total batches from ${data.length} URLs.`,
  );

  const state = loadState(fileToRead, batches.length);
  const failures = loadFailures();
  const PORT = Deno.env.get("PORT") || "8888";
  const HOST = `http://localhost:${PORT}`;

  let startIndex = state.lastProcessedBatchIndex;
  if (
    state.currentBatch &&
    state.currentBatch.batchIndex >= startIndex &&
    state.currentBatch.batchStatus !== "completed"
  ) {
    startIndex = state.currentBatch.batchIndex;
  }

  if (startIndex > 0) {
    console.log(`Resuming from batch index ${startIndex}...`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${authToken}`,
  };

  let activeTracker: BatchTracker | null = null;
  let isShuttingDown = false;

  const socket = createSocketClient(HOST, authToken, (eventName, payload) => {
    if (!activeTracker) {
      return;
    }

    if (eventName === "download-started") {
      markBatchUrlStarted(activeTracker, payload as DownloadStartedEvent);
      persistCurrentBatch(state, activeTracker);
      return;
    }

    if (eventName === "download-done") {
      const success = finalizeBatchUrlSuccess(
        activeTracker,
        payload as DownloadDoneEvent,
      );
      if (success) {
        state.lastSuccess = success;
        state.totals.successes += 1;
      }
      persistCurrentBatch(state, activeTracker);
      return;
    }

    if (eventName === "download-failed") {
      const failure = finalizeBatchUrlFailure(
        activeTracker,
        failures,
        payload as DownloadFailedEvent,
      );
      if (failure) {
        appendFailures(failures, [failure]);
        state.totals.failures += 1;
      }
      persistCurrentBatch(state, activeTracker);
    }
  });

  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.warn(
      `\nReceived ${signal}. Saving current state before exiting...`,
    );
    recordBatchInterrupt(state, activeTracker);
    clearBatchTrackerTimeout(activeTracker);
    socket.close();
    Deno.exit(130);
  };

  const onSigInt = () => shutdown("SIGINT");
  const onSigTerm = () => shutdown("SIGTERM");
  Deno.addSignalListener("SIGINT", onSigInt);
  Deno.addSignalListener("SIGTERM", onSigTerm);

  await socket.ready;
  console.log(`Socket watcher is ready on ${SOCKET_PATH}`);

  for (let i = startIndex; i < batches.length; i++) {
    const batch = batches[i];
    const existingSuccesses = getResumeSuccesses(state, i);
    activeTracker = createBatchTracker(batch, i, existingSuccesses);

    state.lastQueuedBatchIndex = i;
    persistCurrentBatch(state, activeTracker);

    if (
      activeTracker.pendingUrls.size === 0 &&
      activeTracker.startedUrls.size === 0
    ) {
      console.log(
        `[Batch ${
          i + 1
        }/${batches.length}] Already complete from prior run, advancing.`,
      );
      state.lastProcessedBatchIndex = i + 1;
      state.totals.batchesCompleted = state.lastProcessedBatchIndex;
      activeTracker = null;
      persistCurrentBatch(state, null);
      continue;
    }

    console.log(
      `[Batch ${
        i + 1
      }/${batches.length}] Processing playlist: ${batch.playListUrl} (${activeTracker.pendingUrls.size} videos queued, ${existingSuccesses.length} already done)`,
    );

    try {
      const response = await fetch(`${HOST}${DOWNLOAD_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify(
          {
            playListUrl: batch.playListUrl,
            urlList: [...activeTracker.pendingUrls],
          } satisfies BatchPayload,
        ),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`  Error sending batch: ${response.status} ${errText}`);
        const queueFailures = recordQueueFailures(
          activeTracker,
          failures,
          `queue-request-failed: ${response.status}`,
        );
        activeTracker.batchStatus = "completed";

        appendFailures(failures, queueFailures);
        state.totals.failures += queueFailures.length;
        state.lastProcessedBatchIndex = i + 1;
        state.totals.batchesCompleted = state.lastProcessedBatchIndex;
        persistCurrentBatch(state, activeTracker);
        clearBatchTrackerTimeout(activeTracker);
        activeTracker = null;
        persistCurrentBatch(state, null);
        continue;
      }

      console.log(
        "  Batch queued successfully. Waiting for terminal events...",
      );
      activeTracker.batchStatus = "running";
      persistCurrentBatch(state, activeTracker);

      await activeTracker.completionPromise;

      const batchSuccesses = activeTracker.successfulDownloads.size;
      const batchFailures = activeTracker.failedDownloads.size;
      console.log(
        `  Batch finished. Successes: ${batchSuccesses}, failures: ${batchFailures}.`,
      );

      state.lastProcessedBatchIndex = i + 1;
      state.totals.batchesCompleted = state.lastProcessedBatchIndex;
      clearBatchTrackerTimeout(activeTracker);
      activeTracker = null;
      persistCurrentBatch(state, null);
    } catch (error) {
      const message = (error as Error).message;
      console.error(`  Batch ${i + 1} aborted: ${message}`);

      if (activeTracker) {
        if (activeTracker.batchStatus === "running") {
          const timeoutFailures = markBatchTimeoutFailures(
            activeTracker,
            failures,
          );
          if (timeoutFailures.length > 0) {
            appendFailures(failures, timeoutFailures);
            state.totals.failures += timeoutFailures.length;
          }
        } else {
          const queueFailures = recordQueueFailures(
            activeTracker,
            failures,
            `queue-request-error: ${message}`,
          );
          if (queueFailures.length > 0) {
            appendFailures(failures, queueFailures);
            state.totals.failures += queueFailures.length;
          }
        }
        persistCurrentBatch(state, activeTracker);
      }

      socket.close();
      Deno.removeSignalListener("SIGINT", onSigInt);
      Deno.removeSignalListener("SIGTERM", onSigTerm);
      throw error;
    }
  }

  socket.close();
  clearBatchTrackerTimeout(activeTracker);
  state.currentBatch = null;
  saveState(state);
  Deno.removeSignalListener("SIGINT", onSigInt);
  Deno.removeSignalListener("SIGTERM", onSigTerm);

  console.log("\nAll batches finished.");
  console.log(`Successful downloads observed: ${state.totals.successes}`);
  console.log(`Failures recorded: ${failures.length}`);
  if (state.lastSuccess) {
    console.log(
      `Last success: ${state.lastSuccess.videoUrl} at ${state.lastSuccess.completedAt}`,
    );
  }
}

await run();
