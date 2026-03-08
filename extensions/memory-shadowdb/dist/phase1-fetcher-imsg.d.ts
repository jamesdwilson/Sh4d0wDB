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
import type { MessageFetcher } from "./phase1-runner.js";
import type { ExtractedContent } from "./phase1-gmail.js";
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
/**
 * Build a stable, unique message ID for an iMessage.
 * Format: "imsg:<chatId>:<messageId>"
 *
 * @param chatId    - imsg chat ROWID
 * @param messageId - imsg message ROWID
 * @returns         - Stable source ID for deduplication
 */
export declare function buildImsgMessageId(chatId: number, messageId: number): string;
/**
 * Parse newline-delimited JSON from `imsg chats --json`.
 * Optionally filters to chats with last_message_at newer than watermark.
 * Skips malformed lines silently.
 *
 * @param ndjson    - Raw output from imsg chats --json
 * @param watermark - Only return chats with activity after this date; null = all
 * @returns         - Array of chat objects
 */
export declare function parseImsgChats(ndjson: string, watermark?: Date | null): ImsgChat[];
/**
 * Parse newline-delimited JSON from `imsg history --json`.
 * Skips messages with null/empty text and reaction-only messages.
 * Optionally filters to messages newer than watermark.
 *
 * @param ndjson    - Raw output from imsg history --json
 * @param watermark - Only return messages newer than this date; null = all
 * @returns         - Array of substantive message objects
 */
export declare function parseImsgHistory(ndjson: string, watermark?: Date | null): ImsgMessage[];
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
export declare function imsgMessageToExtractedContent(msg: ImsgMessage, chat: ChatContext): ExtractedContent | null;
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
export declare class IMessageFetcher implements MessageFetcher {
    readonly source = "imsg";
    private readonly config;
    private readonly cache;
    constructor(config?: IMessageFetcherConfig);
    getNewMessageIds(watermark: Date | null): Promise<string[]>;
    fetchMessage(id: string): Promise<ExtractedContent | null>;
}
