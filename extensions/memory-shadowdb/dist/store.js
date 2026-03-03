/**
 * store.ts — Abstract base class for memory storage backends
 *
 * Defines the MemoryStore interface that all backends (Postgres, SQLite, MySQL)
 * must implement. Contains shared logic that is identical across backends:
 *
 * - Reciprocal Rank Fusion (RRF) merge of search signals
 * - Primer context assembly (priority ordering, char budgeting, digest)
 * - Relative age formatting ("5d ago")
 * - Snippet and full-record formatting
 * - Input validation and sanitization for writes
 *
 * The contract: backends implement the abstract methods (raw DB operations).
 * This class handles the orchestration and formatting.
 *
 * SECURITY MODEL:
 * - No SQL in this file — all queries delegated to backend implementations
 * - Input validation/sanitization centralized here (single enforcement point)
 * - maxChars bounds on primer injection prevent context overflow
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
// ============================================================================
// Constants — shared validation limits
// ============================================================================
/** Maximum content length in characters. ~100KB of UTF-8 text. */
export const MAX_CONTENT_CHARS = 100_000;
/** Maximum tag count per record. Prevents index bloat. */
export const MAX_TAGS = 50;
/** Maximum length of a single tag string. */
export const MAX_TAG_LENGTH = 200;
/** Maximum length of title and category strings. */
export const MAX_TITLE_LENGTH = 500;
export const MAX_CATEGORY_LENGTH = 100;
/** RRF constant k — standard value from the original RRF paper. */
export const RRF_K = 60;
// ============================================================================
// Abstract Base Class
// ============================================================================
/**
 * Abstract memory store — the contract all backends implement.
 *
 * Shared logic lives here. Backend-specific SQL lives in subclasses.
 * The search pipeline is a template method:
 *   1. Backend runs vectorSearch(), textSearch(), fuzzySearch() in parallel
 *   2. Base class merges results via RRF
 *   3. Base class formats snippets and returns SearchResult[]
 */
export class MemoryStore {
    embedder;
    config;
    logger;
    constructor(embedder, config, logger) {
        this.embedder = embedder;
        this.config = config;
        this.logger = logger;
    }
    // ==========================================================================
    // SEARCH — template method pattern
    // ==========================================================================
    /**
     * Hybrid search: run backend-specific search legs, merge via RRF.
     *
     * Each backend implements vectorSearch/textSearch/fuzzySearch. This method
     * orchestrates them in parallel and combines results using Reciprocal Rank
     * Fusion. The formula: score = Σ weight/(k+rank) across all signals.
     *
     * @param query - User's search query
     * @param maxResults - Maximum results to return
     * @param minScore - Minimum RRF score threshold
     * @param filters - Optional structured filters passed to backend search legs
     * @param detailLevel - Output detail: summary (no content), snippet (default), full (no truncation)
     * @returns Ranked, deduplicated results with snippets and citations
     */
    async search(query, maxResults, minScore, filters, detailLevel) {
        const searchStart = Date.now();
        this.logger.info(`memory-shadowdb: search start — query="${query.slice(0, 80)}", maxResults=${maxResults}, minScore=${minScore}, filters=${filters ? JSON.stringify(filters) : "none"}, detailLevel=${detailLevel || "snippet"}`);
        const embedStart = Date.now();
        const embedding = await this.embedder.embed(query, "query");
        const embedMs = Date.now() - embedStart;
        this.logger.info(`memory-shadowdb: embedding generated in ${embedMs}ms (dims=${embedding.length})`);
        const oversample = maxResults * 5;
        // Run all search legs in parallel — backends return [] for unsupported signals
        const legStart = Date.now();
        const [vectorHits, ftsHits, fuzzyHits] = await Promise.all([
            this.vectorSearch(query, embedding, oversample, filters).catch((err) => {
                this.logger.warn(`memory-shadowdb: vectorSearch failed: ${err instanceof Error ? err.message : String(err)}`);
                return [];
            }),
            this.textSearch(query, oversample, filters).catch((err) => {
                this.logger.warn(`memory-shadowdb: textSearch failed: ${err instanceof Error ? err.message : String(err)}`);
                return [];
            }),
            this.fuzzySearch(query, oversample, filters).catch((err) => {
                this.logger.warn(`memory-shadowdb: fuzzySearch failed: ${err instanceof Error ? err.message : String(err)}`);
                return [];
            }),
        ]);
        const legMs = Date.now() - legStart;
        this.logger.info(`memory-shadowdb: search legs completed in ${legMs}ms — vector=${vectorHits.length}, fts=${ftsHits.length}, fuzzy=${fuzzyHits.length}`);
        // Merge via RRF
        const merged = this.mergeRRF(vectorHits, ftsHits, fuzzyHits, maxResults, minScore);
        const totalMs = Date.now() - searchStart;
        this.logger.info(`memory-shadowdb: search complete in ${totalMs}ms — ${merged.length} results (embed=${embedMs}ms, legs=${legMs}ms)`);
        const level = detailLevel || "snippet";
        // Format as SearchResult[]
        return merged.map((hit) => {
            let snippet;
            if (level === "summary") {
                // Summary: title + category + tags + metadata only, NO content
                const parts = [];
                if (hit.title)
                    parts.push(hit.title);
                if (hit.category)
                    parts.push(`Category: ${hit.category}`);
                if (hit.record_type)
                    parts.push(`Type: ${hit.record_type}`);
                snippet = parts.join(" | ") || `Record #${hit.id}`;
            }
            else if (level === "full") {
                // Full: complete content, no truncation
                snippet = this.formatFullRecord(hit);
            }
            else if (level === "section") {
                // Section: full content of the most relevant ## heading block (~200-500 tokens)
                // Falls back to snippet if no heading structure
                snippet = this.formatSection(hit, query);
            }
            else {
                // Snippet: current default behavior
                snippet = this.formatSnippet(hit);
            }
            const virtualPath = `shadowdb/${hit.category || "general"}/${hit.id}`;
            return {
                path: virtualPath,
                startLine: 1,
                endLine: 1,
                score: hit.rrfScore,
                snippet,
                source: "memory",
                citation: `shadowdb:${this.config.table}#${hit.id}`,
            };
        });
    }
    /**
     * Reciprocal Rank Fusion — merge ranked lists from multiple signals.
     *
     * RRF formula: score_i = Σ_signal weight_signal / (k + rank_signal_i)
     * where k=60 (standard constant from Cormack et al., 2009).
     *
     * Advantages over raw score combination:
     * - No score normalization needed (different signals have different scales)
     * - Robust to outliers in any single signal
     * - Simple, well-studied, hard to break
     */
    mergeRRF(vectorHits, ftsHits, fuzzyHits, maxResults, minScore) {
        // Build a map of id → accumulated RRF score + best metadata
        const scoreMap = new Map();
        const addSignal = (hits, weight) => {
            for (const hit of hits) {
                const contribution = weight / (RRF_K + hit.rank);
                const existing = scoreMap.get(hit.id);
                if (existing) {
                    existing.rrfScore += contribution;
                }
                else {
                    scoreMap.set(hit.id, { hit, rrfScore: contribution });
                }
            }
        };
        addSignal(vectorHits, this.config.vectorWeight);
        addSignal(ftsHits, this.config.textWeight);
        addSignal(fuzzyHits, 0.2); // fixed trigram weight
        // Recency boost: newest records get a small rank-based boost.
        // We rank ALL seen records by created_at (newest first) and apply RRF.
        const allEntries = [...scoreMap.values()];
        const byRecency = [...allEntries]
            .filter((e) => e.hit.created_at != null)
            .sort((a, b) => {
            const dateA = a.hit.created_at instanceof Date ? a.hit.created_at : new Date(a.hit.created_at);
            const dateB = b.hit.created_at instanceof Date ? b.hit.created_at : new Date(b.hit.created_at);
            return dateB.getTime() - dateA.getTime(); // newest first
        });
        byRecency.forEach((entry, idx) => {
            entry.rrfScore += this.config.recencyWeight / (RRF_K + idx + 1);
        });
        // Sort by RRF score descending, apply threshold, return top N
        return allEntries
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .filter((e) => e.rrfScore > Math.max(minScore, 0.001))
            .slice(0, maxResults)
            .map((e) => ({ ...e.hit, rrfScore: e.rrfScore }));
    }
    // ==========================================================================
    // ASSEMBLE — token-budget-aware context assembly
    // ==========================================================================
    /**
     * Assemble context from multiple records within a token budget.
     *
     * Pipeline:
     * 1. Run broad vector search (maxResults=50, minScore=0.001) with optional filters
     * 2. Score each hit: relevance*0.5 + recency_norm*0.2 + (priority/10)*0.3
     *    (weights shifted by `prioritize` param)
     * 3. Fill token budget (approx 4 chars/token) highest score first
     * 4. Return assembled text with citations block
     */
    /** Token budget defaults for task_type presets */
    static TASK_TYPE_BUDGETS = {
        quick: 500,
        outreach: 2000,
        dossier: 5000,
        research: 10000,
    };
    async assemble(params) {
        // Resolve token budget from task_type and/or explicit budget
        const taskBudget = params.task_type
            ? MemoryStore.TASK_TYPE_BUDGETS[params.task_type] ?? 2000
            : undefined;
        const explicitBudget = params.token_budget;
        let resolvedBudget;
        if (taskBudget !== undefined && explicitBudget !== undefined) {
            // Both provided: use the lesser of the two
            resolvedBudget = Math.min(taskBudget, explicitBudget);
        }
        else if (explicitBudget !== undefined) {
            resolvedBudget = explicitBudget;
        }
        else if (taskBudget !== undefined) {
            resolvedBudget = taskBudget;
        }
        else {
            // Neither provided: default to outreach (2000)
            resolvedBudget = 2000;
        }
        const budget = Math.max(100, resolvedBudget);
        const charBudget = budget * 4; // ~4 chars per token
        // Build filters for the vector search
        const filters = {};
        if (params.include_tags && params.include_tags.length > 0) {
            filters.tags_any = params.include_tags;
        }
        // Run a broad search to get candidates
        const candidates = await this.search(params.query, 50, 0.001, Object.keys(filters).length > 0 ? filters : undefined);
        // Post-filter by category (include/exclude)
        let filtered = candidates;
        if (params.include_categories && params.include_categories.length > 0) {
            const cats = new Set(params.include_categories);
            filtered = filtered.filter((r) => {
                const cat = r.path.split("/")[1] || "general";
                return cats.has(cat);
            });
        }
        if (params.exclude_categories && params.exclude_categories.length > 0) {
            const excl = new Set(params.exclude_categories);
            filtered = filtered.filter((r) => {
                const cat = r.path.split("/")[1] || "general";
                return !excl.has(cat);
            });
        }
        // Score weights based on prioritize param
        let wRelevance = 0.5, wRecency = 0.2, wPriority = 0.3;
        if (params.prioritize === "recency") {
            wRelevance = 0.3;
            wRecency = 0.5;
            wPriority = 0.2;
        }
        else if (params.prioritize === "priority") {
            wRelevance = 0.2;
            wRecency = 0.2;
            wPriority = 0.6;
        }
        // Compute composite scores
        const now = Date.now();
        const maxAge = 365 * 24 * 60 * 60 * 1000; // 1 year in ms for normalization
        const maxRrfScore = filtered.length > 0 ? Math.max(...filtered.map((r) => r.score)) : 1;
        const scored = filtered.map((r) => {
            // Normalize relevance to 0-1
            const relevanceNorm = maxRrfScore > 0 ? r.score / maxRrfScore : 0;
            // Recency: 1.0 for now, 0.0 for 1yr+ ago (we don't have created_at in SearchResult,
            // so use RRF score which already incorporates recency)
            const recencyNorm = relevanceNorm; // RRF already blends recency
            // Priority from path: extract ID and we don't have priority in SearchResult,
            // so use a default of 5/10 = 0.5
            const priorityNorm = 0.5;
            const compositeScore = relevanceNorm * wRelevance + recencyNorm * wRecency + priorityNorm * wPriority;
            return { ...r, compositeScore };
        });
        // Sort by composite score descending
        scored.sort((a, b) => b.compositeScore - a.compositeScore);
        // Fill token budget
        const parts = [];
        const citations = [];
        let usedChars = 0;
        let recordsSkipped = 0;
        for (const hit of scored) {
            const content = hit.snippet;
            const contentChars = content.length;
            if (usedChars + contentChars > charBudget) {
                recordsSkipped++;
                continue;
            }
            parts.push(content);
            usedChars += contentChars;
            // Extract ID from citation (shadowdb:table#id)
            const idMatch = hit.citation?.match(/#(\d+)$/);
            const recordId = idMatch ? parseInt(idMatch[1], 10) : 0;
            const titleMatch = content.match(/^# (.+)$/m);
            citations.push({
                id: recordId,
                path: hit.path,
                title: titleMatch?.[1] || null,
                tokensUsed: Math.ceil(contentChars / 4),
            });
        }
        // Build citations block
        const citationsBlock = citations.length > 0
            ? "\n\n---\nSources:\n" + citations.map((c) => `- [${c.id}] ${c.path}${c.title ? ` — ${c.title}` : ""} (~${c.tokensUsed} tok)`).join("\n")
            : "";
        const text = parts.join("\n\n") + citationsBlock;
        const tokenEstimate = Math.ceil(text.length / 4);
        return {
            text,
            tokenEstimate,
            tokenBudget: budget,
            recordsUsed: citations.length,
            recordsSkipped,
            citations,
        };
    }
    // ==========================================================================
    // PRIMER CONTEXT — shared assembly logic
    // ==========================================================================
    /**
     * Load primer context from the `primer` table.
     *
     * Uses PROGRESSIVE FILL (reverse pyramid): rows are ordered by priority
     * (lowest = most important). Each complete section is added only if it fits
     * the remaining character budget. This ensures:
     *
     * - Small models get only the most critical rows (identity, safety)
     * - Large models get everything that fits
     * - Sections are NEVER cut mid-content — you get whole sections or nothing
     * - Priority ordering means the most important context always wins
     *
     * Example with 3000 char budget and rows at priority 0/1/2/3:
     *   Priority 0 (soul, 222 chars)       → fits ✅ (2778 remaining)
     *   Priority 0 (core-rules, 603 chars)  → fits ✅ (2175 remaining)
     *   Priority 1 (nag-system, 890 chars)  → fits ✅ (1285 remaining)
     *   Priority 1 (tool-rules, 912 chars)  → fits ✅ (373 remaining)
     *   Priority 1 (beat-cycle, 627 chars)  → SKIP ❌ (over budget)
     *   Priority 2+ → all skipped
     *
     * @param maxChars - Character budget (0 = unlimited)
     * @returns Primer context with text, digest, and metadata; null if no rows
     */
    async getPrimerContext(maxChars) {
        const primerStart = Date.now();
        const rows = await this.getPrimerRows();
        this.logger.info(`memory-shadowdb: getPrimerContext — ${rows.length} rows from DB, maxChars=${maxChars}`);
        if (rows.length === 0)
            return null;
        // Format each row as a markdown section: ## {key}\n{content}
        const formatted = rows
            .map((row) => {
            const key = String(row.key || "primer").trim();
            const content = String(row.content || "").trim();
            return content ? { key, section: `## ${key}\n${content}` } : null;
        })
            .filter((r) => r !== null);
        if (formatted.length === 0)
            return null;
        // Build full text for digest (so cache invalidation still works when DB changes)
        const fullText = formatted.map((r) => r.section).join("\n\n");
        const digest = createHash("sha1").update(fullText).digest("hex").slice(0, 16);
        const budget = Math.max(0, maxChars);
        // Progressive fill: add whole sections in priority order until budget exhausted
        const included = [];
        const skippedKeys = [];
        let usedChars = 0;
        for (const { key, section } of formatted) {
            // Cost includes the \n\n separator between sections
            const separatorCost = included.length > 0 ? 2 : 0;
            const sectionCost = section.length + separatorCost;
            if (budget > 0 && usedChars + sectionCost > budget) {
                skippedKeys.push(key);
                continue;
            }
            included.push(section);
            usedChars += sectionCost;
        }
        if (included.length === 0)
            return null;
        const text = included.join("\n\n");
        const truncated = skippedKeys.length > 0;
        if (truncated) {
            // Append a note so the agent knows some context was omitted
            const note = `\n\n[primer: ${skippedKeys.length} section(s) omitted due to ${budget} char budget: ${skippedKeys.join(", ")}]`;
            // Only add note if it fits, otherwise skip it silently
            if (text.length + note.length <= budget || budget === 0) {
                const textWithNote = text + note;
                const primerMs = Date.now() - primerStart;
                this.logger.info(`memory-shadowdb: getPrimerContext complete — ${included.length}/${formatted.length} sections, ${textWithNote.length}/${fullText.length} chars, skipped=[${skippedKeys.join(",")}], digest=${digest}, ${primerMs}ms`);
                return { text: textWithNote, digest, totalChars: fullText.length, rowCount: formatted.length, includedCount: included.length, skippedKeys, truncated };
            }
        }
        const primerMs = Date.now() - primerStart;
        this.logger.info(`memory-shadowdb: getPrimerContext complete — ${included.length}/${formatted.length} sections, ${text.length}/${fullText.length} chars, skipped=[${skippedKeys.join(",")}], digest=${digest}, ${primerMs}ms`);
        return { text, digest, totalChars: fullText.length, rowCount: formatted.length, includedCount: included.length, skippedKeys, truncated };
    }
    // ==========================================================================
    // WRITE OPERATIONS — validation + delegation
    // ==========================================================================
    /**
     * Create a new memory record.
     *
     * Validates and sanitizes input, delegates to backend insertRecord(),
     * then optionally generates an embedding.
     */
    async write(params) {
        const content = validateContent(params.content);
        const category = sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general";
        const title = sanitizeString(params.title, MAX_TITLE_LENGTH) || null;
        const tags = sanitizeTags(params.tags);
        const metadata = params.metadata && typeof params.metadata === "object" ? params.metadata : {};
        const parent_id = typeof params.parent_id === "number" ? params.parent_id : null;
        const priority = typeof params.priority === "number" ? Math.min(10, Math.max(1, Math.round(params.priority))) : 5;
        this.logger.info(`memory-shadowdb: write -- category=${category}, title=${title || "(none)"}, tags=[${tags.join(",")}], contentLen=${content.length}`);
        const writeStart = Date.now();
        const newId = await this.insertRecord({ content, category, title, tags, metadata, parent_id, priority });
        const insertMs = Date.now() - writeStart;
        let embedded = false;
        if (this.config.autoEmbed) {
            const embedStart = Date.now();
            embedded = await this.tryEmbed(newId, content);
            const embedMs = Date.now() - embedStart;
            this.logger.info(`memory-shadowdb: write embed — id=${newId}, success=${embedded}, ${embedMs}ms`);
        }
        const totalMs = Date.now() - writeStart;
        const path = `shadowdb/${category}/${newId}`;
        this.logger.info(`memory-shadowdb: write complete — id=${newId}, embedded=${embedded}, ${totalMs}ms (insert=${insertMs}ms)`);
        return {
            ok: true,
            operation: "write",
            id: newId,
            path,
            embedded,
            message: `Created record ${newId}${embedded ? " (embedded)" : " (no embedding)"}`,
        };
    }
    /**
     * Update an existing memory record (partial update).
     *
     * Validates inputs, checks record exists and is not deleted,
     * delegates to backend updateRecord(), re-embeds if content changed.
     */
    async update(params) {
        const existing = await this.getRecordMeta(params.id);
        if (!existing)
            throw new Error(`Record ${params.id} not found`);
        if (existing.deleted_at !== null) {
            throw new Error(`Record ${params.id} is deleted. Use memory_undelete to restore it first.`);
        }
        // Build validated patch
        const patch = {};
        let contentChanged = false;
        if (params.content !== undefined) {
            const content = validateContent(params.content);
            patch.content = content;
            contentChanged = content !== existing.content;
        }
        if (params.title !== undefined) {
            patch.title = sanitizeString(params.title, MAX_TITLE_LENGTH) || null;
        }
        if (params.category !== undefined) {
            patch.category = sanitizeString(params.category, MAX_CATEGORY_LENGTH) || "general";
        }
        if (params.tags !== undefined) {
            patch.tags = sanitizeTags(params.tags);
        }
        if (params.metadata !== undefined && typeof params.metadata === "object") {
            patch.metadata = params.metadata;
        }
        if (params.parent_id !== undefined) {
            patch.parent_id = params.parent_id; // null allowed to unset
        }
        if (params.priority !== undefined && typeof params.priority === "number") {
            patch.priority = Math.min(10, Math.max(1, Math.round(params.priority)));
        }
        if (Object.keys(patch).length === 0) {
            throw new Error("At least one field (content, title, category, tags) must be provided");
        }
        this.logger.info(`memory-shadowdb: update — id=${params.id}, fields=[${Object.keys(patch).join(",")}], contentChanged=${contentChanged}`);
        const updateStart = Date.now();
        await this.updateRecord(params.id, patch);
        let embedded = false;
        if (contentChanged && this.config.autoEmbed) {
            const embedStart = Date.now();
            embedded = await this.tryEmbed(params.id, patch.content);
            this.logger.info(`memory-shadowdb: update embed — id=${params.id}, success=${embedded}, ${Date.now() - embedStart}ms`);
        }
        const totalMs = Date.now() - updateStart;
        const category = patch.category || existing.category || "general";
        const path = `shadowdb/${category}/${params.id}`;
        this.logger.info(`memory-shadowdb: update complete — id=${params.id}, embedded=${embedded}, ${totalMs}ms`);
        return {
            ok: true,
            operation: "update",
            id: params.id,
            path,
            embedded,
            message: `Updated record ${params.id}${contentChanged ? (embedded ? " (re-embedded)" : " (content changed, no embedding)") : ""}`,
        };
    }
    /**
     * Soft-delete a record (set deleted_at, never permanent).
     * Idempotent: deleting an already-deleted record is a no-op.
     */
    async delete(params) {
        const existing = await this.getRecordMeta(params.id);
        if (!existing)
            throw new Error(`Record ${params.id} not found`);
        const category = existing.category || "general";
        const path = `shadowdb/${category}/${params.id}`;
        if (existing.deleted_at !== null) {
            this.logger.info(`memory-shadowdb: delete — id=${params.id} already deleted`);
            return {
                ok: true, operation: "delete", id: params.id, path, embedded: false,
                message: `Record ${params.id} already deleted (deleted_at: ${existing.deleted_at})`,
            };
        }
        this.logger.info(`memory-shadowdb: delete — id=${params.id}, category="${category}"`);
        await this.softDeleteRecord(params.id);
        const purgeNote = this.config.purgeAfterDays > 0
            ? ` Permanent removal in ${this.config.purgeAfterDays} days.`
            : " No auto-purge configured.";
        return {
            ok: true, operation: "delete", id: params.id, path, embedded: false,
            message: `Soft-deleted record ${params.id}.${purgeNote} Use memory_undelete to restore.`,
        };
    }
    /**
     * Restore a soft-deleted record (clear deleted_at).
     */
    async undelete(params) {
        const existing = await this.getRecordMeta(params.id);
        if (!existing) {
            throw new Error(`Record ${params.id} not found (may have been permanently purged)`);
        }
        const category = existing.category || "general";
        const path = `shadowdb/${category}/${params.id}`;
        if (existing.deleted_at === null) {
            this.logger.info(`memory-shadowdb: undelete — id=${params.id} not deleted, no-op`);
            return {
                ok: true, operation: "write", id: params.id, path, embedded: false,
                message: `Record ${params.id} is not deleted — no action needed`,
            };
        }
        this.logger.info(`memory-shadowdb: undelete — id=${params.id}, category="${category}"`);
        await this.restoreRecord(params.id);
        return {
            ok: true, operation: "write", id: params.id, path, embedded: false,
            message: `Restored record ${params.id} — now active and searchable`,
        };
    }
    /**
     * Run retention purge — permanently remove expired soft-deleted records.
     * This is the ONLY code path that permanently deletes data.
     *
     * Before deleting, exports all expired records to a JSON file and moves
     * it to the system trash (or a recovery folder). Nothing is ever lost
     * without a recoverable copy existing first.
     */
    async runRetentionPurge() {
        let purged = 0;
        if (this.config.purgeAfterDays > 0) {
            // Step 1: Fetch the records we're about to purge
            const expired = await this.fetchExpiredRecords(this.config.purgeAfterDays);
            if (expired.length > 0) {
                // Step 2: Export to a dated JSON file
                const dateStr = new Date().toISOString().slice(0, 10);
                const filename = `ShadowDB-Expired-${dateStr}.json`;
                const exportDir = join(homedir(), ".openclaw", "expired");
                mkdirSync(exportDir, { recursive: true });
                const exportPath = join(exportDir, filename);
                writeFileSync(exportPath, JSON.stringify({
                    exportedAt: new Date().toISOString(),
                    purgeAfterDays: this.config.purgeAfterDays,
                    recordCount: expired.length,
                    records: expired,
                }, null, 2) + "\n");
                this.logger.info(`memory-shadowdb: exported ${expired.length} expired record(s) to ${exportPath}`);
                // Step 3: Move the export file to system trash
                this.moveToTrash(exportPath);
                // Step 4: Now safe to delete from database
                purged = await this.purgeExpiredRecords(this.config.purgeAfterDays);
            }
        }
        this.logger.info(`memory-shadowdb: retention sweep — purged ${purged} soft-deleted (>${this.config.purgeAfterDays}d)`);
        return { softDeletePurged: purged };
    }
    /**
     * Move a file to system trash. Tries platform-native trash commands,
     * falls back to leaving the file in place (still recoverable).
     */
    moveToTrash(filePath) {
        const trashCommands = [
            ["trash", filePath], // macOS
            ["gio", "trash", filePath], // Linux (GNOME/freedesktop)
            ["trash-put", filePath], // Linux (trash-cli)
        ];
        for (const cmd of trashCommands) {
            try {
                execSync(cmd.join(" "), { stdio: "ignore" });
                this.logger.info(`memory-shadowdb: moved ${filePath} to system trash`);
                return;
            }
            catch {
                // Command not available or failed — try next
            }
        }
        // No trash command available — leave in recovery folder (still safe)
        this.logger.info(`memory-shadowdb: no system trash available — expired records saved at ${filePath}`);
    }
    // ==========================================================================
    // EMBEDDING — shared try-embed logic
    // ==========================================================================
    /**
     * Attempt to generate and store an embedding for a record.
     * FAIL-OPEN: errors logged but don't propagate. Record persists without vector.
     */
    async tryEmbed(recordId, content) {
        try {
            const embedding = await this.embedder.embed(content, "document");
            await this.storeEmbedding(recordId, embedding);
            return true;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`memory-shadowdb: auto-embed failed for record ${recordId}: ${message}`);
            return false;
        }
    }
    /**
     * Re-embed all non-deleted records with the current embedding configuration.
     * Cursor-based iteration to keep memory bounded. Errors are logged and skipped.
     */
    async reembedAll(onProgress) {
        let lastId = 0;
        let success = 0;
        let errors = 0;
        const batchSize = 100;
        while (true) {
            const batch = await this.getRecordBatch(lastId, batchSize);
            if (batch.length === 0)
                break;
            for (const row of batch) {
                try {
                    const embedding = await this.embedder.embed(row.content, "document");
                    await this.storeEmbedding(row.id, embedding);
                    success++;
                }
                catch (err) {
                    errors++;
                    const message = err instanceof Error ? err.message : String(err);
                    this.logger.warn(`memory-shadowdb: re-embed failed for record ${row.id}: ${message}`);
                }
                lastId = row.id;
            }
            if (onProgress) {
                onProgress(success + errors, success + errors); // total unknown at this point
            }
        }
        return { success, errors };
    }
    // ==========================================================================
    // FORMATTING — shared across all backends
    // ==========================================================================
    /**
     * Format a search result snippet.
     * Compact: category|3d\n{content truncated to 700 chars}
     */
    formatSnippet(row) {
        const maxChars = 700;
        const header = [
            row.category || null,
            row.created_at ? formatRelativeAge(row.created_at) : null,
        ].filter(Boolean).join("|");
        const prefix = header ? `${header}\n` : "";
        const body = (row.content || "").slice(0, maxChars - prefix.length);
        return `${prefix}${body}`.trim();
    }
    /**
     * Format a full record for memory_get results (no truncation).
     */
    formatFullRecord(row) {
        const parts = [];
        if (row.title)
            parts.push(`# ${row.title}`);
        if (row.category)
            parts.push(`Category: ${row.category}`);
        if (row.record_type)
            parts.push(`Type: ${row.record_type}`);
        parts.push("");
        parts.push(row.content || "");
        return parts.join("\n");
    }
    /**
     * Format a section-level result: return the full content up to the most
     * relevant ## heading block (~200-500 tokens). If no heading structure,
     * falls back to snippet behavior.
     *
     * Selects the best section by counting query term overlaps in each block.
     */
    formatSection(row, query) {
        const content = row.content || "";
        // Split content into sections by ## headings
        const sectionRegex = /^## .+$/gm;
        const headingMatches = [];
        let match;
        while ((match = sectionRegex.exec(content)) !== null) {
            headingMatches.push({ index: match.index, text: match[0] });
        }
        // No heading structure — fall back to snippet
        if (headingMatches.length === 0) {
            return this.formatSnippet(row);
        }
        // Extract section blocks (heading + body until next heading or end)
        const sections = [];
        for (let i = 0; i < headingMatches.length; i++) {
            const start = headingMatches[i].index;
            const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : content.length;
            sections.push({
                heading: headingMatches[i].text,
                body: content.slice(start, end).trim(),
            });
        }
        // Score each section by query term overlap
        const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
        let bestIdx = 0;
        let bestScore = -1;
        for (let i = 0; i < sections.length; i++) {
            const sectionLower = sections[i].body.toLowerCase();
            let score = 0;
            for (const term of queryTerms) {
                if (sectionLower.includes(term))
                    score++;
            }
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        // Cap at ~2000 chars (~500 tokens)
        const maxChars = 2000;
        const sectionText = sections[bestIdx].body.slice(0, maxChars);
        const header = [
            row.category || null,
            row.created_at ? formatRelativeAge(row.created_at) : null,
        ].filter(Boolean).join("|");
        return (header ? `${header}\n` : "") + sectionText;
    }
}
// ============================================================================
// Shared Helpers
// ============================================================================
/**
 * Truncate text at a clean boundary (section > paragraph > sentence > word).
 * Walks backward from maxChars to find the best break point.
 * Falls back to hard cut only if no break found in the last 200 chars.
 */
function truncateCleanly(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const slice = text.slice(0, maxChars);
    // Try to break at a section boundary (## heading)
    const lastSection = slice.lastIndexOf("\n## ");
    if (lastSection > maxChars - 500 && lastSection > 0) {
        return slice.slice(0, lastSection).trimEnd();
    }
    // Try to break at a paragraph boundary (double newline)
    const lastPara = slice.lastIndexOf("\n\n");
    if (lastPara > maxChars - 300 && lastPara > 0) {
        return slice.slice(0, lastPara).trimEnd();
    }
    // Try to break at a sentence boundary (. or \n followed by content)
    const lastSentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"), slice.lastIndexOf("\n"));
    if (lastSentence > maxChars - 200 && lastSentence > 0) {
        return slice.slice(0, lastSentence + 1).trimEnd();
    }
    // Try to break at a word boundary (space)
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace > maxChars - 100 && lastSpace > 0) {
        return slice.slice(0, lastSpace).trimEnd();
    }
    // Hard cut — no clean break found
    return slice;
}
/** Validate content: required, non-empty, bounded length. */
function validateContent(raw) {
    const content = (typeof raw === "string" ? raw : "").trim();
    if (!content)
        throw new Error("content is required and must not be empty");
    if (content.length > MAX_CONTENT_CHARS) {
        throw new Error(`content exceeds maximum length: ${content.length} chars (max ${MAX_CONTENT_CHARS})`);
    }
    return content;
}
/** Trim and truncate a string. Returns empty string for non-string input. */
export function sanitizeString(value, maxLength) {
    if (typeof value !== "string")
        return "";
    return value.trim().slice(0, maxLength);
}
/** Validate, deduplicate, and bound a tags array. */
export function sanitizeTags(tags) {
    if (!Array.isArray(tags))
        return [];
    const seen = new Set();
    const result = [];
    for (const tag of tags) {
        if (typeof tag !== "string")
            continue;
        const cleaned = tag.trim().slice(0, MAX_TAG_LENGTH);
        if (!cleaned || seen.has(cleaned))
            continue;
        seen.add(cleaned);
        result.push(cleaned);
        if (result.length >= MAX_TAGS)
            break;
    }
    return result;
}
/**
 * Format a timestamp as a compact relative age string.
 * Examples: "2h ago", "3d ago", "2w ago", "3mo ago", "1y ago"
 */
export function formatRelativeAge(timestamp) {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    if (isNaN(date.getTime()))
        return "";
    const diffMs = Date.now() - date.getTime();
    if (diffMs < 0)
        return "now";
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60)
        return `${Math.max(1, minutes)}m`;
    const hours = Math.floor(diffMs / 3_600_000);
    if (hours < 24)
        return `${hours}h`;
    const days = Math.floor(diffMs / 86_400_000);
    if (days < 14)
        return `${days}d`;
    const weeks = Math.floor(days / 7);
    if (weeks < 9)
        return `${weeks}w`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `${months}mo`;
    const years = Math.floor(days / 365);
    return `${years}y`;
}
//# sourceMappingURL=store.js.map