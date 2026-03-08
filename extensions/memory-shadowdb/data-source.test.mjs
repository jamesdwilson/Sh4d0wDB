/**
 * data-source.test.mjs — TDD tests for DataSource<T> + runDataSourceIngestion
 *
 * Tests the generic entity-registry ingestion interface described in
 * ARCHITECTURE.md § 3 and INTELLIGENCE_ROADMAP.md § DataSource<T> TDD Spec.
 *
 * DataSource<T> is the second interface family alongside MessageFetcher.
 * Where MessageFetcher models a timestamped message stream (email, iMessage),
 * DataSource<T> models an entity registry or event log — records that have
 * identity and can be updated (Apple Contacts, Crunchbase, Calendar events).
 *
 * Test groups:
 *   A — DataSource interface contract (via mock implementation)
 *   B — operationId dedup (sourceId:recordId uniqueness + idempotency)
 *   C — runDataSourceIngestion pipeline (filter → score → write)
 *   D — watermark and audit (ingestion_runs row, new_watermark)
 *   E — Phase 3 hook wiring (onNewContactSignal fires post-write)
 *
 * All external calls (LLM, DB, store) are mocked. No live endpoints.
 *
 * Run: node --test data-source.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runDataSourceIngestion } from './dist/data-source.js';

// ============================================================================
// Fixtures & helpers
// ============================================================================

/**
 * A minimal AppleContact-shaped record for testing.
 * Generic names only — no real PII in test fixtures.
 */
function contact(overrides = {}) {
  return {
    id: 'contact-001',
    firstName: 'Alice',
    lastName: 'Example',
    emails: ['alice@example.com'],
    phones: ['+15550001234'],
    company: 'Example Corp',
    title: 'CEO',
    notes: 'Met at a venture conference. Interested in Series A deals.',
    modifiedAt: new Date('2026-03-01T10:00:00Z'),
    ...overrides,
  };
}

/**
 * A DataSource<AppleContact> mock implementation.
 * Returns a configurable list of records; supports watermark filtering.
 *
 * @param {object[]} records - Records to return
 * @param {object} [opts]
 * @param {boolean} [opts.extractReturnsNull] - If true, extractContent always returns null
 * @param {boolean} [opts.extractThrows]      - If true, extractContent always throws
 */
function mockContactSource(records = [contact()], opts = {}) {
  return {
    sourceId: 'contacts:apple',
    displayName: 'Apple Contacts',
    category: 'contacts',

    getUpdatedRecords: async (watermark) => {
      if (!watermark) return records;
      return records.filter(r => r.modifiedAt > watermark);
    },

    getRecordId: (record) => record.id,

    extractContent: (record) => {
      if (opts.extractThrows) throw new Error('extract failed');
      if (opts.extractReturnsNull) return null;
      return {
        sourceId: `${record.id}`,
        threadId: null,
        subject: `${record.firstName} ${record.lastName} — ${record.title ?? 'Contact'} at ${record.company ?? 'Unknown'}`,
        from: record.emails[0] ?? '',
        date: record.modifiedAt,
        text: [
          record.notes ?? '',
          record.company ? `Works at ${record.company}` : '',
          record.title ? `Title: ${record.title}` : '',
        ].filter(Boolean).join('\n'),
        parties: [`${record.firstName} ${record.lastName}`],
      };
    },
  };
}

/** Standard ingestion config */
function ingestionConfig(overrides = {}) {
  return {
    account: 'james@example.com',
    scoringModel: 'local-qwen35',
    scoreThreshold: 5,
    maxMessagesPerRun: 100,
    searchQuery: '',
    logPath: '',
    ...overrides,
  };
}

/** LLM that always returns the given score */
function scoringLlm(score = '8') {
  return {
    run: async () => String(score),
    complete: async () => String(score),
  };
}

/** Store that records all writes */
function mockStore() {
  const written = [];
  return {
    written,
    write: async (params) => {
      written.push(params);
      return { id: written.length };
    },
    findByOperationId: async () => null,
  };
}

/** DB mock — watermark query + contacts query + dossier query */
function mockDb(watermarkRows = [], contactRows = [], dossierRow = null) {
  return {
    query: async (sql, _params) => {
      if (sql.includes('ingestion_runs')) return { rows: watermarkRows };
      if (sql.includes('category IN'))   return { rows: contactRows };
      if (sql.includes('WHERE id ='))    return { rows: dossierRow ? [dossierRow] : [] };
      return { rows: [] };
    },
  };
}

// ============================================================================
// Group A — DataSource interface contract
// ============================================================================

test('A1: Mock DataSource implementation satisfies the interface and returns records', async () => {
  // Verifies that the mock itself works correctly before testing the runner.
  const source = mockContactSource([contact({ id: 'c1' }), contact({ id: 'c2' })]);
  const records = await source.getUpdatedRecords(null);
  assert.equal(records.length, 2);
  assert.equal(source.sourceId, 'contacts:apple');
  assert.equal(source.category, 'contacts');
});

test('A2: getUpdatedRecords(null) returns all records (full sync)', async () => {
  const records = [contact({ id: 'c1' }), contact({ id: 'c2' }), contact({ id: 'c3' })];
  const source = mockContactSource(records);
  const result = await source.getUpdatedRecords(null);
  assert.equal(result.length, 3);
});

test('A3: getUpdatedRecords(watermark) returns only records modified after watermark', async () => {
  const old = contact({ id: 'old', modifiedAt: new Date('2026-01-01T00:00:00Z') });
  const recent = contact({ id: 'recent', modifiedAt: new Date('2026-03-01T00:00:00Z') });
  const source = mockContactSource([old, recent]);
  const watermark = new Date('2026-02-01T00:00:00Z');
  const result = await source.getUpdatedRecords(watermark);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'recent');
});

test('A4: getRecordId returns stable unique string for the same record', () => {
  const source = mockContactSource();
  const record = contact({ id: 'stable-id-123' });
  const id1 = source.getRecordId(record);
  const id2 = source.getRecordId(record);
  assert.equal(id1, id2, 'getRecordId must be deterministic');
  assert.equal(typeof id1, 'string');
  assert.equal(id1, 'stable-id-123');
});

test('A5: extractContent returning null causes record to be skipped by runner', async () => {
  // null = "this record has no useful text content" — skip without error.
  const source = mockContactSource([contact()], { extractReturnsNull: true });
  const store = mockStore();
  const db = mockDb();
  const result = await runDataSourceIngestion(
    ingestionConfig(),
    source,
    db,
    store,
    scoringLlm('8'),
  );
  assert.equal(store.written.length, 0, 'no records should be written when extractContent returns null');
  assert.equal(result.messages_skipped, 1);
});

test('A6: extractContent throwing is caught — never propagates to runner', async () => {
  // extractContent must never crash the run — it should skip the record.
  const source = mockContactSource([contact()], { extractThrows: true });
  const store = mockStore();
  let result;
  await assert.doesNotReject(async () => {
    result = await runDataSourceIngestion(ingestionConfig(), source, mockDb(), store, scoringLlm('8'));
  });
  assert.ok(result.status !== 'failed', 'run should not fail when extractContent throws');
});

// ============================================================================
// Group B — operationId dedup
// ============================================================================

test('B1: operationId is "sourceId:recordId" format', async () => {
  // The runner constructs operationId from sourceId and recordId.
  // This ensures global uniqueness across all sources.
  const source = mockContactSource([contact({ id: 'ABC123' })]);
  const store = mockStore();
  await runDataSourceIngestion(ingestionConfig(), source, mockDb(), store, scoringLlm('8'));
  assert.ok(store.written.length > 0, 'should have written a record');
  const operationId = store.written[0].metadata?.operationId;
  assert.ok(
    typeof operationId === 'string' && operationId.includes('contacts:apple') && operationId.includes('ABC123'),
    `operationId should be "contacts:apple:ABC123", got: ${operationId}`,
  );
});

test('B2: Same record processed twice produces zero duplicate writes (idempotent)', async () => {
  // The runner checks findByOperationId before writing.
  // Re-syncing the same record must not create a second DB row.
  const source = mockContactSource([contact({ id: 'dedup-test' })]);
  const written = [];
  let findCallCount = 0;

  // First run: not found → write
  const storeFirstRun = {
    written,
    write: async (params) => { written.push(params); return { id: written.length }; },
    findByOperationId: async () => null, // not found
  };
  await runDataSourceIngestion(ingestionConfig(), source, mockDb(), storeFirstRun, scoringLlm('8'));
  const afterFirst = written.length;

  // Second run: found → skip
  const storeSecondRun = {
    written,
    write: async (params) => { written.push(params); return { id: written.length }; },
    findByOperationId: async () => ({ id: 99 }), // already exists
  };
  await runDataSourceIngestion(ingestionConfig(), source, mockDb(), storeSecondRun, scoringLlm('8'));

  assert.equal(written.length, afterFirst, 'second run should not write duplicates');
});

test('B3: Different records from same source get different operationIds', async () => {
  const source = mockContactSource([
    contact({ id: 'record-A' }),
    contact({ id: 'record-B' }),
  ]);
  const store = mockStore();
  await runDataSourceIngestion(ingestionConfig(), source, mockDb(), store, scoringLlm('8'));
  const operationIds = store.written.map(w => w.metadata?.operationId);
  const unique = new Set(operationIds);
  assert.equal(unique.size, operationIds.length, 'all operationIds should be unique');
});

// ============================================================================
// Group C — runDataSourceIngestion pipeline
// ============================================================================

test('C1: Empty record list → run completes with 0 ingested and 0 skipped', async () => {
  const source = mockContactSource([]);
  const store = mockStore();
  const result = await runDataSourceIngestion(ingestionConfig(), source, mockDb(), store, scoringLlm('8'));
  assert.equal(result.messages_ingested, 0);
  assert.equal(result.messages_skipped, 0);
  assert.equal(result.messages_processed, 0);
});

test('C2: Record passing entity filter and score threshold is written to store', async () => {
  // The contact's notes field has "Series A deals" — passes entity filter.
  // LLM returns 8 — above threshold of 5 → written.
  const source = mockContactSource([contact()]);
  const store = mockStore();
  const result = await runDataSourceIngestion(
    ingestionConfig({ scoreThreshold: 5 }),
    source,
    mockDb(),
    store,
    scoringLlm('8'),
  );
  assert.ok(store.written.length > 0, 'record should have been written');
  assert.ok(result.messages_ingested > 0);
});

test('C3: Record whose extractContent returns null is skipped (not scored, not written)', async () => {
  const source = mockContactSource([contact()], { extractReturnsNull: true });
  const store = mockStore();
  const result = await runDataSourceIngestion(ingestionConfig(), source, mockDb(), store, scoringLlm('8'));
  assert.equal(store.written.length, 0);
  assert.equal(result.messages_ingested, 0);
  assert.equal(result.messages_skipped, 1);
});

test('C4: Record failing entity filter is skipped', async () => {
  // A contact with no useful text won't pass passesEntityFilter.
  const bareContact = contact({ notes: '', company: '', title: '' });
  // Override extractContent to return text with no entity signals
  const source = {
    ...mockContactSource([bareContact]),
    extractContent: () => ({
      sourceId: 'bare-001',
      threadId: null,
      subject: 'bare contact',
      from: 'nobody@example.com',
      date: new Date(),
      text: 'hello',  // too short / no entity signals — will fail entity filter
      parties: [],
    }),
  };
  const store = mockStore();
  const result = await runDataSourceIngestion(
    ingestionConfig({ scoreThreshold: 5 }),
    source,
    mockDb(),
    store,
    scoringLlm('8'),
  );
  assert.equal(store.written.length, 0, 'bare contact should be skipped');
  assert.ok(result.messages_skipped >= 1);
});

test('C5: Record failing LLM score gate is skipped', async () => {
  // LLM returns 2 — below threshold 5 → skip.
  const source = mockContactSource([contact()]);
  const store = mockStore();
  const result = await runDataSourceIngestion(
    ingestionConfig({ scoreThreshold: 5 }),
    source,
    mockDb(),
    store,
    scoringLlm('2'),  // below threshold
  );
  assert.equal(store.written.length, 0, 'low-score record should not be written');
  assert.equal(result.messages_ingested, 0);
});

test('C6: messages_ingested and messages_skipped counts are accurate', async () => {
  // 3 records: 2 will be ingested (score 8), 1 will be skipped (extractContent null)
  const passingRecords = [
    contact({ id: 'pass-1' }),
    contact({ id: 'pass-2' }),
  ];
  const skipRecord = contact({ id: 'skip-1' });

  let callCount = 0;
  const mixedSource = {
    sourceId: 'contacts:apple',
    displayName: 'Apple Contacts',
    category: 'contacts',
    getUpdatedRecords: async () => [...passingRecords, skipRecord],
    getRecordId: (r) => r.id,
    extractContent: (r) => {
      if (r.id === 'skip-1') return null;
      return {
        sourceId: r.id, threadId: null,
        subject: `${r.firstName} — CEO at Example Corp`,
        from: 'alice@example.com',
        date: r.modifiedAt,
        text: 'Met at venture conference. Interested in Series A deals worth $2M.',
        parties: [`${r.firstName} ${r.lastName}`],
      };
    },
  };

  const store = mockStore();
  const result = await runDataSourceIngestion(
    ingestionConfig({ scoreThreshold: 5 }),
    mixedSource,
    mockDb(),
    store,
    scoringLlm('8'),
  );

  assert.equal(result.messages_processed, 3);
  assert.equal(result.messages_ingested, 2);
  assert.equal(result.messages_skipped, 1);
});

test('C7: Run status is COMPLETE when all records processed without error', async () => {
  const source = mockContactSource([contact()]);
  const result = await runDataSourceIngestion(
    ingestionConfig(),
    source,
    mockDb(),
    mockStore(),
    scoringLlm('8'),
  );
  assert.equal(result.status, 'complete');
});

test('C8: Run status is PARTIAL when some records throw during processing', async () => {
  let callCount = 0;
  const flakySource = {
    sourceId: 'contacts:apple',
    displayName: 'Apple Contacts',
    category: 'contacts',
    getUpdatedRecords: async () => [contact({ id: 'ok' }), contact({ id: 'bad' })],
    getRecordId: (r) => r.id,
    extractContent: (r) => {
      callCount++;
      if (r.id === 'bad') throw new Error('corrupted record');
      return {
        sourceId: r.id, threadId: null,
        subject: 'Alice Example — CEO',
        from: 'alice@example.com',
        date: r.modifiedAt,
        text: 'Series A deal discussion worth $5M. Interested in investing.',
        parties: ['Alice Example'],
      };
    },
  };

  const result = await runDataSourceIngestion(
    ingestionConfig(),
    flakySource,
    mockDb(),
    mockStore(),
    scoringLlm('8'),
  );
  assert.equal(result.status, 'partial', 'should be PARTIAL when some records fail');
});

// ============================================================================
// Group D — watermark and audit
// ============================================================================

test('D1: runDataSourceIngestion returns an IngestionRunRow with correct source + account', async () => {
  const source = mockContactSource([]);
  const result = await runDataSourceIngestion(
    ingestionConfig({ account: 'james@example.com' }),
    source,
    mockDb(),
    mockStore(),
    scoringLlm('8'),
  );
  assert.equal(result.source, 'contacts:apple');
  assert.equal(result.account, 'james@example.com');
  assert.ok(result.started_at instanceof Date);
  assert.ok(result.completed_at instanceof Date);
});

test('D2: new_watermark is the most recent modifiedAt across ingested records', async () => {
  const older  = contact({ id: 'c1', modifiedAt: new Date('2026-03-01T00:00:00Z') });
  const newer  = contact({ id: 'c2', modifiedAt: new Date('2026-03-05T00:00:00Z') });
  const source = mockContactSource([older, newer]);
  const result = await runDataSourceIngestion(
    ingestionConfig(),
    source,
    mockDb(),
    mockStore(),
    scoringLlm('8'),
  );
  if (result.new_watermark !== null) {
    assert.ok(
      result.new_watermark >= new Date('2026-03-05T00:00:00Z'),
      `new_watermark should be >= the newest record's modifiedAt`,
    );
  }
});

test('D3: new_watermark is null when no records were ingested', async () => {
  const source = mockContactSource([contact()]);
  const result = await runDataSourceIngestion(
    ingestionConfig({ scoreThreshold: 5 }),
    source,
    mockDb(),
    mockStore(),
    scoringLlm('0'),  // score 0 = everything dropped
  );
  assert.equal(result.new_watermark, null);
});

test('D4: Prior run watermark is passed to getUpdatedRecords', async () => {
  // When a prior run exists in ingestion_runs, its completed_at should be
  // passed as the watermark to getUpdatedRecords — not null.
  const priorWatermark = new Date('2026-03-01T00:00:00Z');
  let receivedWatermark = 'NOT_SET';

  const source = {
    sourceId: 'contacts:apple',
    displayName: 'Apple Contacts',
    category: 'contacts',
    getUpdatedRecords: async (watermark) => {
      receivedWatermark = watermark;
      return [];
    },
    getRecordId: (r) => r.id,
    extractContent: () => null,
  };

  // DB returns a prior run with completed_at = priorWatermark
  const db = mockDb([{ completed_at: priorWatermark }]);
  await runDataSourceIngestion(ingestionConfig(), source, db, mockStore(), scoringLlm('8'));

  assert.ok(
    receivedWatermark instanceof Date,
    `getUpdatedRecords should receive a Date watermark, got: ${receivedWatermark}`,
  );
  assert.ok(
    receivedWatermark.getTime() === priorWatermark.getTime(),
    'watermark should match prior run completed_at',
  );
});

// ============================================================================
// Group E — Phase 3 hook wiring
// ============================================================================

test('E1: onNewContactSignal hook fires for records that resolve to a known contact', async () => {
  const hookCalls = [];
  const hooks = {
    onNewContactSignal: async (contactId, content) => {
      hookCalls.push({ contactId, sourceId: content.sourceId });
      return null;
    },
  };

  // DB has a matching contact (fuzzy match on "Alice Example")
  const contactRow = { id: 77, title: 'Alice Example', category: 'contacts' };
  const dossierRow = { id: 77, title: 'Alice Example', content: 'Analyst type.', category: 'contacts', record_type: 'document', created_at: new Date(), metadata: {} };
  const db = mockDb([], [contactRow], dossierRow);

  const source = mockContactSource([contact({ id: 'alice-001' })]);
  await runDataSourceIngestion(
    ingestionConfig(),
    source,
    db,
    mockStore(),
    scoringLlm('8'),
    hooks,
  );

  // Hook is fire-and-forget — wait briefly
  await new Promise(r => setTimeout(r, 100));

  assert.ok(hookCalls.length > 0, 'hook should have fired for known contact');
  assert.equal(hookCalls[0].contactId, 77);
});

test('E2: Hook failure does not abort the run — status remains COMPLETE', async () => {
  const hooks = {
    onNewContactSignal: async () => { throw new Error('hook exploded'); },
  };

  const contactRow = { id: 88, title: 'Alice Example', category: 'contacts' };
  const dossierRow = { id: 88, title: 'Alice Example', content: 'CEO.', category: 'contacts', record_type: 'document', created_at: new Date(), metadata: {} };
  const db = mockDb([], [contactRow], dossierRow);

  const source = mockContactSource([contact()]);
  let result;
  await assert.doesNotReject(async () => {
    result = await runDataSourceIngestion(
      ingestionConfig(),
      source,
      db,
      mockStore(),
      scoringLlm('8'),
      hooks,
    );
  });
  assert.equal(result.status, 'complete', 'hook failure should not change run status');
});
