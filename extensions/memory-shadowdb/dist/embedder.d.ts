/**
 * embedder.ts — Embedding provider implementations for memory-shadowdb
 *
 * Unified client for multiple embedding providers with strict dimension validation.
 * All providers receive text input (max 6000 chars) and return float[] embeddings.
 *
 * SECURITY MODEL:
 * - API keys are never logged (passed to constructor, used in Authorization headers)
 * - Input text is truncated to 6000 chars to prevent DoS via large inputs
 * - Command-based provider: command path from config only, not user input
 * - HTTP errors include truncated response body (max 300 chars) to avoid log spam
 *
 * SUPPORTED PROVIDERS:
 * - ollama: local inference server, no auth
 * - openai: OpenAI API (text-embedding-3-small/large)
 * - openai-compatible: any OpenAI-compatible API (e.g., Azure, local proxies)
 * - voyage: Voyage AI API
 * - gemini: Google Gemini API
 * - command: external process via stdin/stdout JSON
 *
 * DATA FLOW:
 * 1. Text input (truncated to 6000 chars)
 * 2. Provider-specific API call or command execution
 * 3. Parse response → extract embedding vector
 * 4. Validate dimensions against config
 * 5. Return validated float[] to caller
 */
import type { EmbeddingProvider } from "./types.js";
/**
 * Unified embedding client supporting multiple providers
 *
 * This class encapsulates all provider-specific logic and presents a uniform
 * embed(text) → Promise<number[]> interface to the rest of the plugin.
 *
 * SECURITY NOTES:
 * - API keys are stored in private fields and never logged
 * - All HTTP requests use fetch with explicit headers (no ambient auth)
 * - Input truncation (6000 chars) prevents DoS via large text inputs
 * - Dimension validation ensures output matches pgvector schema
 *
 * CONCURRENCY:
 * - This client is stateless and safe for concurrent embed() calls
 * - No connection pooling (HTTP requests are one-shot via fetch)
 * - Command-based provider spawns a new process per embed() call
 */
export declare class EmbeddingClient {
    private provider;
    private model;
    private dimensions;
    private apiKey;
    private ollamaUrl;
    private baseUrl;
    private headers;
    private voyageInputType;
    private geminiTaskType;
    private command?;
    private commandArgs;
    private commandTimeoutMs;
    constructor(params: {
        provider: EmbeddingProvider;
        model: string;
        dimensions: number;
        apiKey?: string;
        ollamaUrl?: string;
        baseUrl?: string;
        headers?: Record<string, string>;
        voyageInputType?: "query" | "document";
        geminiTaskType?: string;
        command?: string;
        commandArgs?: string[];
        commandTimeoutMs?: number;
    });
    /**
     * Get the configured embedding dimensions.
     * Used by backends to create vector columns/tables with the right size.
     */
    getDimensions(): number;
    /**
     * Generate embedding vector for input text
     *
     * Delegates to provider-specific implementation, then validates dimensions.
     *
     * SECURITY: Input is truncated to 6000 chars to prevent DoS.
     * This limit is enforced in each provider method.
     *
     * @param text - Input text to embed
     * @returns Embedding vector (validated to match expected dimensions)
     * @throws Error if provider fails or dimensions don't match
     */
    embed(text: string, purpose?: "query" | "document"): Promise<number[]>;
    /**
     * Ollama provider implementation
     *
     * Ollama runs locally (typically localhost:11434) and requires no authentication.
     * API: POST /api/embeddings with JSON {model, prompt}
     *
     * @param text - Input text (truncated to 6000 chars)
     * @returns Embedding vector from Ollama
     * @throws Error if HTTP request fails or response is invalid
     */
    /**
     * Resolve task prefix for models that use them (e.g., nomic-embed-text).
     * Returns undefined for models that don't need prefixes.
     */
    private resolveTaskPrefix;
    private embedOllama;
    /**
     * OpenAI and OpenAI-compatible provider implementation
     *
     * Supports:
     * - OpenAI API (api.openai.com)
     * - Azure OpenAI
     * - Any OpenAI-compatible API (local proxies, other providers)
     *
     * API: POST /v1/embeddings with JSON {model, input, dimensions?}
     *
     * SECURITY: Requires API key in Authorization header (Bearer token).
     * Key is never logged.
     *
     * @param text - Input text (truncated to 6000 chars)
     * @returns Embedding vector from OpenAI-compatible API
     * @throws Error if API key missing, HTTP fails, or response invalid
     */
    private embedOpenAICompatible;
    /**
     * Voyage AI provider implementation
     *
     * Voyage API: POST /v1/embeddings with JSON {model, input, input_type}
     * input_type: "query" (for search queries) or "document" (for indexed content)
     *
     * SECURITY: Requires VOYAGE_API_KEY in Authorization header.
     *
     * @param text - Input text (truncated to 6000 chars)
     * @returns Embedding vector from Voyage AI
     * @throws Error if API key missing, HTTP fails, or response invalid
     */
    private embedVoyage;
    /**
     * Google Gemini provider implementation
     *
     * Gemini API: POST /v1beta/{model}:embedContent with JSON {content, taskType}
     * API key passed as query parameter (?key=...)
     *
     * SECURITY: API key in query string (Gemini API requirement).
     * URL-encode key to handle special characters.
     *
     * @param text - Input text (truncated to 6000 chars)
     * @returns Embedding vector from Gemini
     * @throws Error if API key missing, HTTP fails, or response invalid
     */
    private embedGemini;
    /**
     * Command-based provider implementation
     *
     * Spawns external process and communicates via stdin/stdout with JSON.
     *
     * INPUT (stdin): {"text": "...", "model": "...", "dimensions": N}
     * OUTPUT (stdout): [float, ...] OR {"embedding": [float, ...]}
     *
     * SECURITY:
     * - Command path comes from config only (never user input)
     * - Process is killed after timeout (default 15s)
     * - Stderr is captured but not logged in full (max 500 chars on error)
     * - Input text truncated to 6000 chars before sending to process
     *
     * @param text - Input text (truncated to 6000 chars)
     * @returns Embedding vector from external command
     * @throws Error if command fails, times out, or returns invalid JSON
     */
    private embedCommand;
}
