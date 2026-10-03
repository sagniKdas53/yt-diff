import type {
  DownloadProcessEntry,
  ListingProcessEntry,
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
} from "./listing.ts";
import { processCancelRequest } from "./cancel.ts";
import { locateVideo, processLocateRequest } from "./locate.ts";
import { processListingRequest } from "./listing-requests.ts";

export * from "./types.ts";

export function createPipelineHandlers(deps: PipelineHandlerDependencies) {
  const downloadProcesses = new Map<string, DownloadProcessEntry>();
  const listProcesses = new Map<string, ListingProcessEntry>();

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
    resolveAndEnqueue: downloadFlow.resolveAndEnqueue,
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
    getQueueSnapshot: downloadFlow.getQueueSnapshot,
    syncExtras: downloadFlow.syncExtras,
    getListingQueueDepth: () => getListingQueueDepth(listingRuntime),
  };
}
