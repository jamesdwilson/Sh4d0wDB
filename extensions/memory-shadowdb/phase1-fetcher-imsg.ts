/**
 * phase1-fetcher-imsg.ts — IMessageFetcher: MessageFetcher impl via imsg CLI
 *
 * Implements MessageFetcher for iMessage/SMS using the `imsg` CLI
 * (github.com/nicholasstephan/imsg, installed via Homebrew).
 *
 * Strategy:
 *   1. getNewMessageIds() — list all chats via `imsg chats --json`,
 *      filter by last_message_at > watermark, return synthetic message IDs
 *      (one per substantive message via `imsg history --json` per chat)
 *   2. fetchMessage()    — parse a pre-built ExtractedContent from the
 *      message cache populated by getNewMessageIds()
 *
 * Message ID format: "imsg:<chatId>:<messageId>" — stable, unique, dedup-safe.
 *
 * Source identifier: "imsg" (stored in ingestion_runs.source)
 *
 * Note: imsg outputs newline-delimited JSON (one object per line), not a JSON array.
 * All parse functions handle this format.
 */

import { execSync } from "node:child_process";
import type { MessageFetcher } from "./phase1-runner.js";
import type { ExtractedContent } from "./phase1-gmail.js";

// ============================================================================
// Types
// ============================================================================

/** A chat row from imsg chats --json */
export interface ImsgChat {
  readonly id: number;
  readonly identifier: string;
  readonly name: string;
  readonly service: string;
  readonly last_message_at: string;
}

/** A message row from imsg history --json */
export interface ImsgMessage {
  readonly id: number;
  readonly guid: string;
  readonly text: string | null;
  readonly is_from_me: boolean;
  readonly created_at: string;
  readonly sender: string;
  readonly chat_id: number;
  readonly attachments: unknown[];
  readonly reactions: unknown[];
}

/** Context about the chat a message belongs to (for party extraction) */
export interface ChatContext {
  readonly identifier: string;
  readonly name: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Prefix for all iMessage source IDs */
const SOURCE_PREFIX = "imsg";

/**
 * Patterns for messages that are metadata/reactions, not real content.
 * These should be skipped — they're not indexable text.
 */
const REACTION_PATTERNS: RegExp[] = [
  /^Reacted .+ to [""]/i,
  /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) [""]/i,
  /^\uFFFC/,  // Object replacement character (attachment placeholder)
];

/** Minimum text length to consider a message worth parsing */
const MIN_TEXT_LENGTH = 10;

// ============================================================================
// Public pure functions (tested)
// ============================================================================

/**
 * Build a stable, unique message ID for an iMessage.
 * Format: "imsg:<chatId>:<messageId>"
 *
 * @param chatId    - imsg chat ROWID
 * @param messageId - imsg message ROWID
 * @returns         - Stable source ID for deduplication
 */
export function buildImsgMessageId(chatId: number, messageId: number): string {
  return `${SOURCE_PREFIX}:${chatId}:${messageId}`;
}

/**
 * Parse newline-delimited JSON from `imsg chats --json`.
 * Optionally filters to chats with last_message_at newer than watermark.
 * Skips malformed lines silently.
 *
 * @param ndjson    - Raw output from imsg chats --json
 * @param watermark - Only return chats with activity after this date; null = all
 * @returns         - Array of chat objects
 */
export function parseImsgChats(ndjson: string, watermark?: Date | null): ImsgChat[] {
  const chats: ImsgChat[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const chat = JSON.parse(trimmed) as ImsgChat;
      if (!chat?.id || !chat?.identifier) continue;
      if (watermark) {
        const lastMsg = new Date(chat.last_message_at);
        if (isNaN(lastMsg.getTime()) || lastMsg <= watermark) continue;
      }
      chats.push(chat);
    } catch {
      // skip malformed lines
    }
  }
  return chats;
}

/**
 * Parse newline-delimited JSON from `imsg history --json`.
 * Skips messages with null/empty text and reaction-only messages.
 * Optionally filters to messages newer than watermark.
 *
 * @param ndjson    - Raw output from imsg history --json
 * @param watermark - Only return messages newer than this date; null = all
 * @returns         - Array of substantive message objects
 */
export function parseImsgHistory(ndjson: string, watermark?: Date | null): ImsgMessage[] {
  const messages: ImsgMessage[] = [];
  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as ImsgMessage;
      if (!msg?.id || !msg?.guid) continue;

      // Skip null/empty text
      if (!msg.text || msg.text.trim().length < MIN_TEXT_LENGTH) continue;

      // Skip reactions and metadata messages
      if (REACTION_PATTERNS.some(p => p.test(msg.text!))) continue;

      // Apply watermark filter
      if (watermark) {
        const msgDate = new Date(msg.created_at);
        if (isNaN(msgDate.getTime()) || msgDate <= watermark) continue;
      }

      messages.push(msg);
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}

/**
 * Convert an imsg message + chat context to ExtractedContent.
 *
 * Returns null for:
 *   - Reaction-only messages ("Reacted 👍 to ...")
 *   - Messages shorter than MIN_TEXT_LENGTH after trimming
 *
 * Party extraction:
 *   - Named chat → use chat name
 *   - 1:1 chat  → use sender phone/ID (contact resolution happens in resolveParties)
 *   - is_from_me → "Me" (filtered by resolveParties as self)
 *
 * @param msg     - imsg message row
 * @param chat    - Chat context (identifier + name)
 * @returns       - ExtractedContent, or null to skip
 */
export function imsgMessageToExtractedContent(
  msg: ImsgMessage,
  chat: ChatContext,
): ExtractedContent | null {
  const text = msg.text?.trim() ?? "";

  // Skip reactions
  if (REACTION_PATTERNS.some(p => p.test(text))) return null;

  // Skip too-short
  if (text.length < MIN_TEXT_LENGTH) return null;

  const date = new Date(msg.created_at);
  if (isNaN(date.getTime())) return null;

  const sourceId = buildImsgMessageId(msg.chat_id, msg.id);

  // Extract parties
  const parties: string[] = [];
  if (chat.name && chat.name.trim()) {
    parties.push(chat.name.trim());
  } else if (!msg.is_from_me && msg.sender) {
    parties.push(msg.sender);
  }

  return {
    sourceId,
    threadId: `imsg:${msg.chat_id}`,
    subject: chat.name
      ? `iMessage: ${chat.name}`
      : `iMessage with ${msg.sender}`,
    from: msg.is_from_me ? "me" : msg.sender,
    date,
    text,
    parties,
  };
}

// ============================================================================
// IMessageFetcher — MessageFetcher implementation
// ============================================================================

/** Configuration for IMessageFetcher */
export interface IMessageFetcherConfig {
  /** Maximum messages to fetch per chat per run (0 = unlimited) */
  maxPerChat?: number;
  /** Maximum chats to process per run (0 = unlimited) */
  maxChats?: number;
}

/**
 * MessageFetcher implementation for iMessage/SMS via imsg CLI.
 *
 * On getNewMessageIds(): fetches all chats newer than watermark,
 * then fetches message history for each, caches ExtractedContent by ID.
 *
 * On fetchMessage(): returns from cache (populated by getNewMessageIds).
 * Never makes a second CLI call per message.
 *
 * NEVER throws — returns empty arrays / null on any CLI error.
 */
export class IMessageFetcher implements MessageFetcher {
  readonly source = "imsg";

  private readonly config: Required<IMessageFetcherConfig>;
  private readonly cache = new Map<string, ExtractedContent>();

  constructor(config: IMessageFetcherConfig = {}) {
    this.config = {
      maxPerChat: config.maxPerChat ?? 0,
      maxChats:   config.maxChats   ?? 0,
    };
  }

  async getNewMessageIds(watermark: Date | null): Promise<string[]> {
    this.cache.clear();

    // Step 1: Get all chats
    let chatOutput: string;
    try {
      chatOutput = execSync("imsg chats --limit 9999 --json", {
        timeout: 30_000,
        encoding: "utf8",
      });
    } catch {
      return [];
    }

    let chats = parseImsgChats(chatOutput, watermark);
    if (this.config.maxChats > 0) chats = chats.slice(0, this.config.maxChats);

    const ids: string[] = [];

    // Step 2: For each chat, get message history
    for (const chat of chats) {
      try {
        const maxFlag = this.config.maxPerChat > 0
          ? `--limit ${this.config.maxPerChat}`
          : "--limit 999";
        const historyOutput = execSync(
          `imsg history --chat-id ${chat.id} ${maxFlag} --json`,
          { timeout: 15_000, encoding: "utf8" },
        );

        const messages = parseImsgHistory(historyOutput, watermark);
        const chatCtx: ChatContext = { identifier: chat.identifier, name: chat.name };

        for (const msg of messages) {
          const content = imsgMessageToExtractedContent(msg, chatCtx);
          if (!content) continue;
          this.cache.set(content.sourceId, content);
          ids.push(content.sourceId);
        }
      } catch {
        // skip this chat on error
      }
    }

    return ids;
  }

  async fetchMessage(id: string): Promise<ExtractedContent | null> {
    return this.cache.get(id) ?? null;
  }
}
