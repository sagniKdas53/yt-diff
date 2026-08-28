import { logger } from "../logger.ts";
import { HELP_TEXT, parseCommand } from "./commands.ts";
import {
  handleHistory,
  handleKeep,
  handleList,
  handlePlaylists,
  handleRemove,
  handleSearch,
  handleStatus,
} from "./queries.ts";
import { handleIndex } from "./indexing.ts";
import { reply } from "./replies.ts";
import {
  type BotCoreDependencies,
  type BotRuntime,
  createBotRuntime,
  isAllowed,
} from "./runtime.ts";
import { handleSubmission } from "./submissions.ts";
import { createSubscriptions } from "./subscriptions.ts";
import type { DeliveryTarget, IncomingMessage } from "./types.ts";

export type { BotCoreDependencies, ListingResultLike } from "./runtime.ts";

/**
 * Entry point for every incoming message.
 *
 * Messages from chats outside the allowlist are dropped silently — replying
 * would confirm the bot exists to anyone probing.
 */
export async function handleMessage(
  rt: BotRuntime,
  message: IncomingMessage,
): Promise<void> {
  if (!isAllowed(rt, message.chatId)) {
    logger.debug("Ignoring message from a non-allowlisted chat", {
      platform: message.platform,
      chatId: message.chatId,
    });
    return;
  }

  const adapter = rt.adaptersByPlatform.get(message.platform);
  if (!adapter) {
    return;
  }

  const target: DeliveryTarget = {
    platform: adapter.platform,
    chatId: message.chatId,
  };
  const command = parseCommand(message.text);

  try {
    switch (command.kind) {
      case "ignore":
        return;
      case "help":
        await reply(adapter, target, HELP_TEXT);
        return;
      case "status":
        await handleStatus(rt, adapter, target);
        return;
      case "history":
        await handleHistory(rt, adapter, target, command.limit);
        return;
      case "keep":
        await handleKeep(rt, adapter, target, command.id);
        return;
      case "remove":
        await handleRemove(rt, adapter, target, command.id);
        return;
      case "index":
        await handleIndex(
          rt,
          adapter,
          target,
          command.url,
          command.monitoringType,
        );
        return;
      case "list":
        await handleList(
          rt,
          adapter,
          target,
          command.url,
          command.start,
          command.limit,
        );
        return;
      case "playlists":
        await handlePlaylists(rt, adapter, target, command.limit);
        return;
      case "search":
        await handleSearch(rt, adapter, target, command.query, command.limit);
        return;
      case "get":
        await handleSubmission(rt, adapter, message, command.url, "file");
        return;
      case "link":
        await handleSubmission(rt, adapter, message, command.url, "link");
        return;
      case "download":
        await handleSubmission(rt, adapter, message, command.url, "store");
        return;
      case "unknown":
        await reply(adapter, target, "I didn't understand that. Try /help.");
        return;
    }
  } catch (error) {
    logger.error("Bot failed to handle a message", {
      chatId: message.chatId,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    await reply(adapter, target, "Something went wrong handling that.");
  }
}

/**
 * Assembles the bot.
 *
 * This was a 1,351-line factory: thirty-three nested functions sharing two
 * in-flight maps by closure, which meant none of them could be reached without
 * standing up the whole bot. The state is now `BotRuntime`, handed to each
 * handler explicitly, and the handlers live beside the thing they do —
 * `submissions.ts`, `indexing.ts`, `queries.ts`, `deliver.ts`, `replies.ts`
 * and `subscriptions.ts`. What is left here is the wiring and the command
 * routing that fans out to them.
 */
export function createBotCore(deps: BotCoreDependencies) {
  const rt = createBotRuntime(deps);
  const { subscribe, unsubscribe } = createSubscriptions(rt);

  return {
    handleMessage: (message: IncomingMessage) => handleMessage(rt, message),
    subscribe,
    unsubscribe,
  };
}
