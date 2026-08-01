import { Bot, InputFile } from "grammy";

import { logger } from "../../logger.ts";
import type {
  BotAdapter,
  DeliveryTarget,
  IncomingMessage,
  MessageRef,
} from "../types.ts";

export interface TelegramAdapterOptions {
  token: string;
  maxUploadBytes: number;
}

/**
 * Telegram implementation of BotAdapter, backed by grammy.
 *
 * Deliberately thin: every decision about what to say and when lives in
 * BotCore. This only translates between grammy's API and the shared contracts.
 */
export function createTelegramAdapter(
  options: TelegramAdapterOptions,
): BotAdapter {
  const bot = new Bot(options.token);

  return {
    platform: "telegram",
    maxUploadBytes: options.maxUploadBytes,

    start(onMessage: (message: IncomingMessage) => Promise<void>) {
      bot.on("message:text", async (ctx) => {
        await onMessage({
          platform: "telegram",
          chatId: String(ctx.chat.id),
          messageId: String(ctx.message.message_id),
          text: ctx.message.text.trim(),
        });
      });

      bot.catch((error) => {
        logger.error("Telegram bot error", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // bot.start() only resolves when the bot stops, so it must not be
      // awaited here or bootstrap would block forever.
      void bot.start({
        onStart: (info) => {
          logger.info("Telegram bot connected", { username: info.username });
        },
      });

      return Promise.resolve();
    },

    async stop() {
      await bot.stop();
    },

    async sendText(to: DeliveryTarget, text: string): Promise<MessageRef> {
      const sent = await bot.api.sendMessage(to.chatId, text, {
        link_preview_options: { is_disabled: true },
      });
      return {
        platform: "telegram",
        chatId: to.chatId,
        messageId: String(sent.message_id),
      };
    },

    async editText(ref: MessageRef, text: string) {
      await bot.api.editMessageText(ref.chatId, Number(ref.messageId), text, {
        link_preview_options: { is_disabled: true },
      });
    },

    async sendFile(
      to: DeliveryTarget,
      absPath: string,
      caption: string,
    ): Promise<MessageRef> {
      // sendVideo lets Telegram clients play it inline rather than offering a
      // download, which is the whole point of uploading instead of linking.
      const sent = await bot.api.sendVideo(to.chatId, new InputFile(absPath), {
        caption: caption.slice(0, 1024),
        supports_streaming: true,
      });
      return {
        platform: "telegram",
        chatId: to.chatId,
        messageId: String(sent.message_id),
      };
    },
  };
}
