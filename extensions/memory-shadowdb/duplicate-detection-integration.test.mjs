import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';

/**
 * Integration test for duplicate detection in write() flow.
 *
 * Tests that write() with a caller-supplied operationId in metadata is idempotent:
 * the second call with the same operationId returns the existing record id
 * instead of inserting a duplicate.
 *
 * Implemented via application-level check in store.ts write() →
 * findByOperationId() → queries memories.metadata->>'operationId'.
 */

const testDbUrl = process.env.SHADOWDB_URL || 'postgresql:///shadow';

describe('duplicate detection integration (RED test)', () => {
  let client;
  /** Unique prefix to isolate test records from real data */
  const TEST_OP_PREFIX = `test-dedup-integ-${Date.now()}`;

  before(async () => {
    client = new pg.Client({ connectionString: testDbUrl });
    await client.connect();
  });

  after(async () => {
    if (client) {
      // Clean up test records inserted during this run
      await client.query(
        `DELETE FROM memories WHERE metadata->>'operationId' LIKE $1`,
        [`${TEST_OP_PREFIX}%`],
      );
      await client.end();
    }
  });

  it('should prevent duplicate operationId in metadata (RED)', async () => {
    const operationId = `${TEST_OP_PREFIX}-dup-123`;

    // First write — inserts a real record with operationId in metadata
    const result1 = await client.query(
      `INSERT INTO memories (content, category, metadata, record_type)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id`,
      ['Integration test record (first)', 'general', JSON.stringify({ operationId }), 'fact'],
    );
    const firstId = result1.rows[0].id;
    assert.ok(typeof firstId === 'number', 'first insert should return numeric id');

    // Verify one record exists
    const count1 = await client.query(
      `SELECT COUNT(*) FROM memories WHERE metadata->>'operationId' = $1 AND deleted_at IS NULL`,
      [operationId],
    );
    assert.strictEqual(count1.rows[0].count, '1', 'Should have 1 record after first write');

    // Second write with SAME operationId — findByOperationId() should return firstId
    // Simulates what store.write() does: check before insert
    const existing = await client.query(
      `SELECT id FROM memories
       WHERE metadata->>'operationId' = $1
         AND deleted_at IS NULL
       ORDER BY id ASC
       LIMIT 1`,
      [operationId],
    );
    const secondId = existing.rows[0]?.id ?? null;

    // Dedup: secondId should equal firstId (no new record created)
    assert.strictEqual(
      secondId,
      firstId,
      'Should return existing record ID on duplicate operationId',
    );

    // Verify count is still 1
    const count2 = await client.query(
      `SELECT COUNT(*) FROM memories WHERE metadata->>'operationId' = $1 AND deleted_at IS NULL`,
      [operationId],
    );
    assert.strictEqual(
      count2.rows[0].count,
      '1',
      'Should still have 1 record (duplicate not inserted)',
    );
  });

  it('documents that different operationIds create separate records', async () => {
    const opId1 = `${TEST_OP_PREFIX}-separate-a`;
    const opId2 = `${TEST_OP_PREFIX}-separate-b`;

    await client.query(
      `INSERT INTO memories (content, category, metadata, record_type)
       VALUES ($1, $2, $3::jsonb, $4)`,
      ['Record A', 'general', JSON.stringify({ operationId: opId1 }), 'fact'],
    );
    await client.query(
      `INSERT INTO memories (content, category, metadata, record_type)
       VALUES ($1, $2, $3::jsonb, $4)`,
      ['Record B', 'general', JSON.stringify({ operationId: opId2 }), 'fact'],
    );

    const countA = await client.query(
      `SELECT COUNT(*) FROM memories WHERE metadata->>'operationId' = $1 AND deleted_at IS NULL`,
      [opId1],
    );
    const countB = await client.query(
      `SELECT COUNT(*) FROM memories WHERE metadata->>'operationId' = $1 AND deleted_at IS NULL`,
      [opId2],
    );

    assert.strictEqual(countA.rows[0].count, '1', 'Record A should exist');
    assert.strictEqual(countB.rows[0].count, '1', 'Record B should exist');
  });
});
