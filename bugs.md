# Bugs

## Backend

1. `[open]` Playlist bootstrap fails when the first items are hidden/unlisted

     * Example: <https://www.youtube.com/playlist?list=PLwLSw1_eDZl3mojgeqUHyMpTt3lQ6ogmJ>
     * Current cause: playlist creation currently tries to resolve playlist metadata from the first playlist item, so if the early entries are unavailable the playlist can fail before normal listing proceeds
     * Planned fix: make playlist creation tolerant of missing early items, or defer playlist row creation until the listing stream yields a valid item

2. `[fixed, not tested]` Failed playlist bootstrap still burns the next playlist sort index

     * Example sequence:
     * Last successful playlist index was `6`
     * A later playlist bootstrap failed
     * The next successful playlist was inserted at index `8`
     * Current cause: the in-memory pending sort counter is incremented before playlist creation fully succeeds
     * Planned fix: only reserve the next sort index after playlist creation is guaranteed to succeed, or resync the counter from DB on failure

3. `[fixed, tested]` Adding to `"None"` needs better duplicate and location feedback

     * Fix implemented: if a video already exists in the DB but not yet in `"None"`, the backend now inserts the `"None"` mapping directly without re-fetching metadata from the source URL
     * Fix implemented: if the video was already downloaded in another playlist, the UI reports a success message with the source playlist title and position
     * Fix implemented: duplicates in `"None"` now use a standardized error message that includes the video title or URL plus the indexed position navigated to
     * Fix implemented: duplicate/add notifications for `"None"` no longer expose filesystem paths in the UI

4. `[open]` Important snack events should also appear in the notification center

     * Current state: some socket-driven events already create notifications, but coverage is inconsistent across socket and REST flows
     * Planned fix: audit all important user-visible success/error/info paths and standardize snackbar + notification-center behavior

5. `[fixed, not tested]` Duplicate playlist entries could not be deleted one at a time

     * Example playlist: <https://www.youtube.com/playlist?list=PL4Oo6H2hGqj0YkYoOLFmrbhsVWfAjCLZw>
     * Previous behavior: deleting one duplicate removed all mappings for the same `videoUrl` in that playlist
     * Fix implemented: `/getsub` now returns the playlist mapping row `id`, and `/delsub` now deletes by mapping `id` so a single duplicate row can be removed without removing the others

## Frontend

6. `[open]` Thumbnail signed URLs should refresh when they expire

     * Current gap: the frontend bulk thumbnail flow has no expiry metadata to schedule refreshes
     * Planned fix: either extend `/getfiles` to return structured `{ signedUrlId, expiry }` entries or add a dedicated batch refresh API such as `/refreshfiles`

7. `[not-a-bug]` Refresh file can appear to flood requests if expiry is very short

     * `const timeUntilExpiry = expiryRef.current - Date.now();`
     * `const refreshTime = Math.max(0, timeUntilExpiry - 300000);`
     * Example response: `{"status":"success","signedUrlId":"4dc1c692-108f-4aa8-a2e2-39756ba968b5","expiry":1776590323959}`
     * Conclusion: this is working as designed for short expiries

8. `[open]` Player refresh timer can continue after unmount/track change

     * Current state: the component clears timers on cleanup, but there is still a stale-timer/stale-ref race to harden
     * Planned fix: bind refresh callbacks to the specific `fileId` they were scheduled for and guard updates after unmount

9. `[open]` `/getfiles` does not return expiry time, so the frontend cannot know when to refresh thumbnails

     * This is the backend piece needed for the thumbnail refresh work above
