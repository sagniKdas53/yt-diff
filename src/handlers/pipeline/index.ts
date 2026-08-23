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
  createListingRuntime,
  getListingQueueDepth,
  listItemsConcurrently,
} from "./listing.ts";
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
    getListingQueueDepth: () => getListingQueueDepth(listingRuntime),
  };
}
