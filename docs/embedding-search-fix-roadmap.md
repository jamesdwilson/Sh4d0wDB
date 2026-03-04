# ShadowDB Embedding Search Failure — Fix Roadmap

**Status:** INVESTIGATION
**Created:** 2026-03-04 01:01 CST
**Priority:** CRITICAL
**Impact:** Close, important contact (Beth Womack) not findable despite 30 records with recent embeddings

---

## Summary

The `memory_search` tool completely failed to find Beth Womack despite:
- 30+ records in the database (IDs 9880–10643)
- All records have embeddings (embedded=30, null_embeddings=1)
- Embeddings are recent (March 3, 12:31–12:42)
- Beth Womack is a close, important contact with rich history

**Manual SQL queries work perfectly** — all Beth records are easily retrievable via direct queries. The problem is isolated to the `memory_search` tool.

---

## Root Cause Analysis

### Evidence Gathered

1. **Records exist with embeddings**
   - Beth Womack has 30 matching records
   - 29 have embeddings, 1 does not
   - Embeddings are recent (created/updated March 3, 12:31–12:42)

2. **Manual SQL finds all Beth records**
   ```sql
   SELECT * FROM memories WHERE title ILIKE '%Beth Womack%';
   SELECT * FROM memories WHERE fts @@ to_tsquery('english', 'Beth | Womack');
   ```
   Both return all Beth records correctly.

3. **memory_search returns wrong results**
   - Result: Generic Planka kanban board entries (0.013 confidence)
   - Expected: Beth Womack records (should have high relevance)
   - Config: `minScore: 0.005`, `maxResults: 3`

4. **Config check**
   - Provider: ollama
   - Model: nomic-embed-text
   - Dimensions: 768
   - Embedding URL: http://localhost:11434

### Likely Root Causes

1. **Query embedding generation broken**
   - The search tool might not be generating proper embeddings for "Beth Womack"
   - Or it's using cached/incorrect query embeddings

2. **Search algorithm issue**
   - The tool might be getting stuck on cached/low-confidence results
   - OR: The search algorithm doesn't prioritize Beth despite 30 matching records

3. **Result filtering too aggressive**
   - `minScore: 0.005` is low, but maybe results are being filtered at a higher level
   - OR: The tool stops early when it finds "enough" results (maxResults: 3)

4. **Embedding pipeline failure**
   - The Ollama service might not be responding correctly
   - Or the embedding generation for query vs document is inconsistent

---

## Investigation Steps

### Step 1: Debug the Embedding Pipeline

**What to check:**
- Does Ollama respond to embedding requests?
- Is the query embedding generation producing valid 768-dim vectors?
- Is the embedding generation for Beth records different from the query?

**How to verify:**
```bash
# Test Ollama embedding service
curl http://localhost:11434/api/embeddings -d '{
  "model": "nomic-embed-text",
  "prompt": "Beth Womack"
}'

# Test embedding a long sentence
curl http://localhost:11434/api/embeddings -d '{
  "model": "nomic-embed-text",
  "prompt": "James Wilson has a close relationship with Beth Womack from their frequent communication"
}'
```

**Expected output:** 768-dim vector

### Step 2: Inspect Memory Search Tool Code

**Location:** `~/.openclaw/plugins/memory-shadowdb/` (TypeScript/JavaScript)

**What to check:**
- How does the tool generate query embeddings?
- How does it query the database (pgvector, FTS, etc.)?
- How does it filter and rank results?
- Is there any caching or result limiting?

**Key files:**
- `tools.js` (main implementation)
- `index.ts` (plugin entry point)
- `search.ts` (search logic)

### Step 3: Test Direct Embedding Query

**SQL test:**
```sql
-- Generate a query embedding for "Beth Womack"
-- Then find most similar records
SELECT id, title, category,
  embedding <=> '[query_embedding]' as distance,
  ts_rank(fts, to_tsquery('english', 'Beth | Womack')) as fts_rank
FROM memories
WHERE fts @@ to_tsquery('english', 'Beth | Womack')
ORDER BY
  embedding <=> '[query_embedding]' DESC,
  ts_rank(fts, to_tsquery('english', 'Beth | Womack')) DESC
LIMIT 10;
```

**Expected:** Beth Womack records should appear at the top.

### Step 4: Check Embedding Index Integrity

**What to check:**
- Is the `memories_embedding_hnsw_idx` index working?
- Are all Beth records properly embedded?
- Is there any corruption in the embedding data?

**SQL tests:**
```sql
-- Check embedding index status
SELECT indexrelid::regclass, indrelid::regclass
FROM pg_index
WHERE indexrelname = 'memories_embedding_hnsw_idx';

-- Check embedding dimensions
SELECT id, title,
  array_length(embedding::int[], 1) as dim,
  updated_at
FROM memories
WHERE title ILIKE '%Beth%'
LIMIT 5;
```

**Expected:** All Beth records should have 768-dim embeddings.

---

## Fix Plan

### Phase 1: Debug and Isolate (20 min)

**Actions:**
1. Test Ollama embedding service manually
2. Inspect the memory search tool code
3. Run direct SQL embedding queries
4. Document findings

**Success criteria:**
- Confirmed root cause (which of the 4 likely causes)
- Understanding of where in the pipeline the failure occurs
- Clear hypothesis for the fix

### Phase 2: Implement Fix (30 min)

**Based on root cause, implement:**

**If query embedding is broken:**
- Fix the query embedding generation code
- Add error handling for embedding failures
- Add logging for debugging

**If search algorithm is broken:**
- Fix the search logic to properly rank Beth Womack records
- Add logging for query embeddings and results
- Improve result filtering logic

**If embedding pipeline is broken:**
- Fix Ollama integration
- Add fallback embedding providers
- Add health checks for embedding service

**If index is corrupted:**
- Re-embed affected records
- Rebuild the HNSW index
- Test search again

### Phase 3: Test and Validate (15 min)

**Actions:**
1. Test search for "Beth Womack"
2. Test search for other close contacts
3. Test search for generic queries
4. Verify no regressions

**Success criteria:**
- Beth Womack appears in search results
- Other close contacts are findable
- General search still works
- No new errors or failures

### Phase 4: Document and Cleanup (10 min)

**Actions:**
1. Update this document with findings
2. Document the fix
3. Add logging/metrics for monitoring
4. Clean up debug code

**Success criteria:**
- Complete documentation of the issue and fix
- Clear notes on what was changed
- Monitoring in place

---

## Success Criteria

**Hard requirements:**
1. ✅ Beth Womack is findable via `memory_search`
2. ✅ Other close contacts are findable
3. ✅ General search still works correctly
4. ✅ No regression in performance or accuracy

**Nice to have:**
1. Improved logging for debugging
2. Health checks for embedding service
3. Better error handling
4. Metrics for search performance

---

## Monitoring Plan

### Checkpoint 1: Initial State

**Recorded:**
- Status: INVESTIGATION
- Beth Womack records: 30 (all embedded)
- Embeddings recent: March 3, 12:31–12:42
- memory_search fails completely
- Manual SQL works

### Checkpoint 2: After Phase 1

**Actions:**
- Test Ollama service
- Inspect tool code
- Run direct SQL embedding queries

**Expected:**
- Root cause identified
- Clear hypothesis for fix

### Checkpoint 3: After Phase 2

**Actions:**
- Implement fix
- Test fix
- Verify results

**Expected:**
- Beth Womack is findable
- Other contacts are findable

### Checkpoint 4: Final State

**Actions:**
- Final testing
- Documentation complete
- Monitoring in place

**Expected:**
- All success criteria met
- Documentation complete
- Monitoring enabled

---

## Notes

### Why This Matters

Beth Womack is described as:
- "Close and important contact"
- "Rich history of messaging"
- "Recent interactions"

The fact that she's not findable despite all this data is a **critical failure**. If a close contact can't be found, the system has a fundamental usability issue.

### What Could Go Wrong

1. **Fix introduces new bugs** — Need comprehensive testing
2. **Embedding service is down** — Need fallback/health checks
3. **Embeddings are corrupted** — Need re-embedding logic
4. **Fix doesn't address root cause** — Need careful diagnosis

### Future Considerations

1. **Add embedding health checks** — Monitor Ollama service
2. **Add search performance metrics** — Track latency and accuracy
3. **Add result logging** — Debug future search failures
4. **Add more thorough testing** — Test with various queries and contacts

---

## Status Tracker

| Checkpoint | Date | Status | Notes |
|------------|------|--------|-------|
| Initial | 2026-03-04 01:01 | ✅ Complete | Investigation started |
| Phase 1 | TBD | ⏳ Pending | Debug and isolate |
| Phase 2 | TBD | ⏳ Pending | Implement fix |
| Phase 3 | TBD | ⏳ Pending | Test and validate |
| Phase 4 | TBD | ⏳ Pending | Document and cleanup |
| Final | TBD | ⏳ Pending | All success criteria met |

---

**Next step:** Test Ollama embedding service and inspect memory search tool code.
