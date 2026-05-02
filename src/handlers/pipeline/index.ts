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
import { createListingFlow } from "./listing.ts";

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
  const listingFlow = createListingFlow(deps, listProcesses, processManager);

  return {
    cleanupStaleProcesses,
    downloadProcesses,
    listProcesses,
    listItemsConcurrently: listingFlow.listItemsConcurrently,
    processDownloadRequest: downloadFlow.processDownloadRequest,
    processListingRequest: listingFlow.processListingRequest,
    resetPendingPlaylistSortCounter:
      listingFlow.resetPendingPlaylistSortCounter,
  };
}
