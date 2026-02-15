/**
 * embedder.ts — Embedding provider implementations for memory-shadowdb
 *
 * Unified client for multiple embedding providers with strict dimension validation.
 * All providers receive text input (max 8000 chars) and return float[] embeddings.
 *
 * SECURITY MODEL:
 * - API keys are never logged (passed to constructor, used in Authorization headers)
 * - Input text is truncated to 8000 chars to prevent DoS via large inputs
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
 * 1. Text input (truncated to 8000 chars)
 * 2. Provider-specific API call or command execution
 * 3. Parse response → extract embedding vector
 * 4. Validate dimensions against config
 * 5. Return validated float[] to caller
 */

import { spawn } from "node:child_process";
import type { EmbeddingProvider } from "./types.js";
import { validateEmbeddingDimensions } from "./config.js";

/**
 * Unified embedding client supporting multiple providers
 *
 * This class encapsulates all provider-specific logic and presents a uniform
 * embed(text) → Promise<number[]> interface to the rest of the plugin.
 *
 * SECURITY NOTES:
 * - API keys are stored in private fields and never logged
 * - All HTTP requests use fetch with explicit headers (no ambient auth)
 * - Input truncation (8000 chars) prevents DoS via large text inputs
 * - Dimension validation ensures output matches pgvector schema
 *
 * CONCURRENCY:
 * - This client is stateless and safe for concurrent embed() calls
 * - No connection pooling (HTTP requests are one-shot via fetch)
 * - Command-based provider spawns a new process per embed() call
 */
export class EmbeddingClient {
  private provider: EmbeddingProvider;
  private model: string;
  private dimensions: number;
  private apiKey: string;
  private ollamaUrl: string;
  private baseUrl: string;
  private headers: Record<string, string>;
  private voyageInputType: "query" | "document";
  private geminiTaskType: string;
  private command?: string;
  private commandArgs: string[];
  private commandTimeoutMs: number;

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
  }) {
    this.provider = params.provider;
    this.model = params.model;
    this.dimensions = params.dimensions;
    this.apiKey = params.apiKey || "";
    this.ollamaUrl = params.ollamaUrl || "http://localhost:11434";
    this.baseUrl = params.baseUrl || "";
    this.headers = params.headers || {};
    this.voyageInputType = params.voyageInputType || "query";
    this.geminiTaskType = params.geminiTaskType || "RETRIEVAL_QUERY";
    this.command = params.command;
    this.commandArgs = params.commandArgs || [];
    this.commandTimeoutMs = params.commandTimeoutMs || 15_000;
  }

  /**
   * Generate embedding vector for input text
   *
   * Delegates to provider-specific implementation, then validates dimensions.
   *
   * SECURITY: Input is truncated to 8000 chars to prevent DoS.
   * This limit is enforced in each provider method.
   *
   * @param text - Input text to embed
   * @returns Embedding vector (validated to match expected dimensions)
   * @throws Error if provider fails or dimensions don't match
   */
  async embed(text: string): Promise<number[]> {
    let embedding: number[];

    switch (this.provider) {
      case "ollama":
        embedding = await this.embedOllama(text);
        break;
      case "openai":
      case "openai-compatible":
        embedding = await this.embedOpenAICompatible(text);
        break;
      case "voyage":
        embedding = await this.embedVoyage(text);
        break;
      case "gemini":
        embedding = await this.embedGemini(text);
        break;
      case "command":
        embedding = await this.embedCommand(text);
        break;
      default:
        throw new Error(`Unsupported embedding provider: ${this.provider}`);
    }

    // SECURITY/CORRECTNESS: Validate dimensions before returning
    // Fail loudly on mismatch instead of silently corrupting the vector index
    return validateEmbeddingDimensions(
      embedding,
      this.dimensions,
      `${this.provider}:${this.model}`,
    );
  }

  /**
   * Ollama provider implementation
   *
   * Ollama runs locally (typically localhost:11434) and requires no authentication.
   * API: POST /api/embeddings with JSON {model, prompt}
   *
   * @param text - Input text (truncated to 8000 chars)
   * @returns Embedding vector from Ollama
   * @throws Error if HTTP request fails or response is invalid
   */
  private async embedOllama(text: string): Promise<number[]> {
    // SECURITY: Truncate input to prevent DoS via large text
    const truncated = text.slice(0, 8000);
    
    const response = await fetch(`${this.ollamaUrl.replace(/\/$/, "")}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify({ model: this.model, prompt: truncated }),
    });
    
    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
    }
    
    const data = (await response.json()) as { embedding?: number[] };
    
    if (!Array.isArray(data.embedding)) {
      throw new Error("Ollama embedding response missing `embedding` array");
    }
    
    return data.embedding;
  }

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
   * @param text - Input text (truncated to 8000 chars)
   * @returns Embedding vector from OpenAI-compatible API
   * @throws Error if API key missing, HTTP fails, or response invalid
   */
  private async embedOpenAICompatible(text: string): Promise<number[]> {
    // SECURITY: API key validation — fail early if missing
    if (!this.apiKey) {
      throw new Error(`API key missing for embedding provider ${this.provider}`);
    }
    
    // SECURITY: Truncate input to prevent DoS
    const truncated = text.slice(0, 8000);
    
    const body: Record<string, unknown> = {
      model: this.model,
      input: truncated,
    };
    
    // Include dimensions parameter if configured (text-embedding-3-* supports this)
    if (this.dimensions > 0) {
      body.dimensions = this.dimensions;
    }

    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SECURITY: API key in Authorization header, never logged
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      // Include truncated error body for debugging (max 300 chars to avoid log spam)
      const errText = await response.text().catch(() => "");
      throw new Error(
        `${this.provider} embedding failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    
    const embedding = data?.data?.[0]?.embedding;
    
    if (!Array.isArray(embedding)) {
      throw new Error(`${this.provider} response missing data[0].embedding`);
    }
    
    return embedding;
  }

  /**
   * Voyage AI provider implementation
   *
   * Voyage API: POST /v1/embeddings with JSON {model, input, input_type}
   * input_type: "query" (for search queries) or "document" (for indexed content)
   *
   * SECURITY: Requires VOYAGE_API_KEY in Authorization header.
   *
   * @param text - Input text (truncated to 8000 chars)
   * @returns Embedding vector from Voyage AI
   * @throws Error if API key missing, HTTP fails, or response invalid
   */
  private async embedVoyage(text: string): Promise<number[]> {
    // SECURITY: API key validation
    if (!this.apiKey) {
      throw new Error("VOYAGE_API_KEY (or embedding.apiKey) is required for provider=voyage");
    }
    
    // SECURITY: Truncate input
    const truncated = text.slice(0, 8000);
    
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // SECURITY: API key never logged
        Authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify({
        model: this.model,
        input: [truncated], // Voyage expects array of strings
        input_type: this.voyageInputType,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Voyage embedding failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
      embeddings?: number[][];
    };
    
    // Voyage may return either data[0].embedding or embeddings[0]
    const embedding = data?.data?.[0]?.embedding || data?.embeddings?.[0];
    
    if (!Array.isArray(embedding)) {
      throw new Error("Voyage response missing embedding vector");
    }
    
    return embedding;
  }

  /**
   * Google Gemini provider implementation
   *
   * Gemini API: POST /v1beta/{model}:embedContent with JSON {content, taskType}
   * API key passed as query parameter (?key=...)
   *
   * SECURITY: API key in query string (Gemini API requirement).
   * URL-encode key to handle special characters.
   *
   * @param text - Input text (truncated to 8000 chars)
   * @returns Embedding vector from Gemini
   * @throws Error if API key missing, HTTP fails, or response invalid
   */
  private async embedGemini(text: string): Promise<number[]> {
    // SECURITY: API key validation
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY/GOOGLE_API_KEY (or embedding.apiKey) is required for provider=gemini");
    }
    
    // SECURITY: Truncate input
    const truncated = text.slice(0, 8000);
    
    // Gemini model path format: models/{model-name}
    const modelPath = this.model.startsWith("models/") ? this.model : `models/${this.model}`;
    
    // API key in query string (Gemini API convention)
    // SECURITY: encodeURIComponent prevents injection if key contains special chars
    const endpoint = `${this.baseUrl.replace(/\/$/, "")}/v1beta/${modelPath}:embedContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({
        content: {
          parts: [{ text: truncated }],
        },
        taskType: this.geminiTaskType, // e.g., "RETRIEVAL_QUERY"
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Gemini embedding failed: ${response.status} ${response.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`,
      );
    }

    const data = (await response.json()) as {
      embedding?: { values?: number[] };
    };
    
    const embedding = data?.embedding?.values;
    
    if (!Array.isArray(embedding)) {
      throw new Error("Gemini response missing embedding.values");
    }
    
    return embedding;
  }

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
   * - Input text truncated to 8000 chars before sending to process
   *
   * @param text - Input text (truncated to 8000 chars)
   * @returns Embedding vector from external command
   * @throws Error if command fails, times out, or returns invalid JSON
   */
  private async embedCommand(text: string): Promise<number[]> {
    if (!this.command) {
      throw new Error("embedding.command is required when provider=command");
    }
    
    // SECURITY: Truncate input before sending to external process
    const truncated = text.slice(0, 8000);

    const payload = JSON.stringify({
      text: truncated,
      model: this.model,
      dimensions: this.dimensions,
    });

    const result = await runCommandForEmbedding({
      command: this.command,
      args: this.commandArgs,
      stdin: payload,
      timeoutMs: this.commandTimeoutMs,
    });

    // Parse stdout as JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`embedding.command returned non-JSON output: ${result.stdout.slice(0, 300)}`);
    }

    // Accept two formats:
    // 1. Direct array: [float, float, ...]
    // 2. Object with embedding field: {"embedding": [float, ...]}
    
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "number")) {
      return parsed as number[];
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { embedding?: unknown }).embedding)
    ) {
      const emb = (parsed as { embedding: unknown[] }).embedding;
      if (emb.every((x) => typeof x === "number")) {
        return emb as number[];
      }
    }

    throw new Error("embedding.command JSON must be [number,...] or {\"embedding\":[number,...]}");
  }
}

/**
 * Execute external command for embedding generation
 *
 * Spawns process, writes JSON payload to stdin, reads stdout/stderr,
 * enforces timeout, and returns output.
 *
 * SECURITY:
 * - Command path and args come from config (trusted source)
 * - Process inherits environment (embedding commands may need API keys from env)
 * - Timeout enforced with SIGTERM (prevents hung processes)
 * - Stderr captured but truncated in error messages (max 500 chars)
 *
 * ERROR HANDLING:
 * - Non-zero exit: rejects with stderr (truncated)
 * - Timeout: kills process and rejects
 * - Spawn error: rejects immediately
 *
 * @param params - Command execution parameters
 * @returns stdout and stderr output
 * @throws Error if command fails, times out, or returns non-zero exit
 */
async function runCommandForEmbedding(params: {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // SECURITY: Command and args from config only (not user input)
    const child = spawn(params.command, params.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env, // Inherit env (embedding commands may need API keys)
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // SECURITY: Timeout enforcement to prevent hung processes
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM"); // Graceful termination signal
      reject(new Error(`embedding.command timed out after ${params.timeoutMs}ms`));
    }, params.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      
      if (code !== 0) {
        // SECURITY: Truncate stderr to prevent log spam (max 500 chars)
        reject(new Error(`embedding.command exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });

    // Write JSON payload to stdin and close
    child.stdin.write(params.stdin);
    child.stdin.end();
  });
}
