import type {
  DownloadProcessEntry,
  ListingProcessEntry,
  PausedJob,
  PipelineHandlerDependencies,
} from "./types.ts";
import {
  cleanupStaleProcesses,
  createProcessManager,
} from "./process-manager.ts";
import { createDownloadFlow } from "./download.ts";
import {
  cancelListing,
  createListingRuntime,
  getListingQueueDepth,
  listItemsConcurrently,
  resumeListing,
} from "./listing.ts";
import { createJobControl, processJobActionRequest } from "./job-control.ts";
import { processCancelRequest } from "./cancel.ts";
import { locateVideo, processLocateRequest } from "./locate.ts";
import { processListingRequest } from "./listing-requests.ts";

export * from "./types.ts";

export function createPipelineHandlers(deps: PipelineHandlerDependencies) {
  const downloadProcesses = new Map<string, DownloadProcessEntry>();
  const listProcesses = new Map<string, ListingProcessEntry>();
  // Jobs stopped on request. Kept apart from both process maps because they
  // have no process, and those maps are swept on staleness clocks.
  const pausedJobs = new Map<string, PausedJob>();

  const processManager = createProcessManager(downloadProcesses, listProcesses);
  const downloadFlow = createDownloadFlow(
    deps,
    downloadProcesses,
    processManager,
  );
  const listingRuntime = createListingRuntime(
    deps,
    listProcesses,
    processManager,
  );
  const jobControl = createJobControl({
    downloadProcesses,
    listProcesses,
    listingRuntime,
    pausedJobs,
    resumeDownload: downloadFlow.resumeDownload,
    resumeListing: (job: PausedJob) => resumeListing(listingRuntime, job),
  });

  return {
    cleanupStaleProcesses,
    downloadProcesses,
    listProcesses,
    listItemsConcurrently: (
      items: Parameters<typeof listItemsConcurrently>[1],
      chunkSize: Parameters<typeof listItemsConcurrently>[2],
      isScheduledUpdate: Parameters<typeof listItemsConcurrently>[3],
    ) =>
      listItemsConcurrently(
        listingRuntime,
        items,
        chunkSize,
        isScheduledUpdate,
      ),
    processDownloadRequest: downloadFlow.processDownloadRequest,
    processSyncExtrasRequest: downloadFlow.processSyncExtrasRequest,
    processLocateRequest,
    locateVideo,
    cancelDownload: downloadFlow.cancelDownload,
    cancelListing: (url: string) => cancelListing(listingRuntime, url),
    processCancelRequest: (
      requestBody: Parameters<typeof processCancelRequest>[1],
      response: Parameters<typeof processCancelRequest>[2],
    ) =>
      processCancelRequest(
        {
          cancelDownload: downloadFlow.cancelDownload,
          cancelListing: (url: string) => cancelListing(listingRuntime, url),
        },
        requestBody,
        response,
      ),
    processJobActionRequest: (
      requestBody: Parameters<typeof processJobActionRequest>[1],
      response: Parameters<typeof processJobActionRequest>[2],
    ) => processJobActionRequest(jobControl, requestBody, response),
    resolveAndEnqueue: downloadFlow.resolveAndEnqueue,
    resumeDownload: downloadFlow.resumeDownload,
    processListingRequest: (
      requestBody: Parameters<typeof processListingRequest>[1],
      response: Parameters<typeof processListingRequest>[2],
    ) =>
      processListingRequest(
        {
          safeEmit: listingRuntime.safeEmit,
          enqueue: (items, chunkSize, isScheduledUpdate) =>
            listItemsConcurrently(
              listingRuntime,
              items,
              chunkSize,
              isScheduledUpdate,
            ),
          queueDepth: () => getListingQueueDepth(listingRuntime),
        },
        requestBody,
        response,
      ),
    getQueueSnapshot: jobControl.getQueueSnapshot,
    getListingSnapshot: jobControl.getListingSnapshot,
    pauseJob: jobControl.pauseJob,
    resumeJob: jobControl.resumeJob,
    cancelJob: jobControl.cancelJob,
    syncExtras: downloadFlow.syncExtras,
    getListingQueueDepth: () => getListingQueueDepth(listingRuntime),
  };
}
