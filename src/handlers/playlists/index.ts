import type { PlaylistHandlerDependencies } from "./types.ts";
import { createMutationHandlers } from "./mutations.ts";
import { createQueryHandlers } from "./queries.ts";

export * from "./types.ts";

export function createPlaylistHandlers(deps: PlaylistHandlerDependencies) {
  const mutations = createMutationHandlers(deps);
  const queries = createQueryHandlers(deps);

  return {
    updatePlaylistMonitoring: mutations.updatePlaylistMonitoring,
    processDeletePlaylistRequest: mutations.processDeletePlaylistRequest,
    processReindexAllRequest: mutations.processReindexAllRequest,
    processDeleteVideosRequest: mutations.processDeleteVideosRequest,
    getPlaylistsForDisplay: queries.getPlaylistsForDisplay,
    getSubListVideos: queries.getSubListVideos,
  };
}
