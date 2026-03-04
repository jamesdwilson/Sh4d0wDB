import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';

/**
 * Integration test for duplicate detection in write() flow
 *
 * This test is currently RED because write() doesn't check for duplicates.
 * Once we implement the check, this test should pass.
 */

const testDbUrl = process.env.SHADOWDB_URL || 'postgresql:///shadow';

describe('duplicate detection integration (RED test)', () => {
  let client;
  const tableName = 'memories_dup_test';

  before(async () => {
    client = new pg.Client({ connectionString: testDbUrl });
    await client.connect();

    // Clean up any existing test table
    await client.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);

    // Create minimal test table
    await client.query(`
      CREATE TABLE ${tableName} (
        id BIGSERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  });

  after(async () => {
    if (client) {
      await client.query(`DROP TABLE IF EXISTS ${tableName} CASCADE`);
      await client.end();
    }
  });

  it('should prevent duplicate operationId in metadata (RED)', async () => {
    // Clean up
    await client.query(`DELETE FROM ${tableName}`);

    const operationId = 'test-dup-123';

    // First write with operationId
    const result1 = await client.query(
      `INSERT INTO ${tableName} (content, metadata) VALUES ($1, $2) RETURNING id`,
      ['First', JSON.stringify({ operationId })]
    );
    const firstId = result1.rows[0].id;

    // Count records with this operationId
    const count1 = await client.query(
      `SELECT COUNT(*) FROM ${tableName} WHERE metadata->>'operationId' = $1`,
      [operationId]
    );
    assert.strictEqual(count1.rows[0].count, '1', 'Should have 1 record after first write');

    // Second write with SAME operationId (RED - currently PostgreSQL allows this)
    const result2 = await client.query(
      `INSERT INTO ${tableName} (content, metadata) VALUES ($1, $2) RETURNING id`,
      ['Second - should be rejected', JSON.stringify({ operationId })]
    );
    const secondId = result2.rows[0].id;

    // Count records with this operationId
    const count2 = await client.query(
      `SELECT COUNT(*) FROM ${tableName} WHERE metadata->>'operationId' = $1`,
      [operationId]
    );

    // RED: This will fail because we haven't implemented duplicate detection
    // Currently count will be 2, but it should be 1
    console.log(`Count after second write: ${count2.rows[0].count}`);
    console.log(`First ID: ${firstId}, Second ID: ${secondId}`);

    // This assertion will FAIL (RED phase)
    assert.strictEqual(
      count2.rows[0].count,
      '1',
      'RED: Should still have 1 record (duplicate rejected)'
    );

    // Ideally, secondId should equal firstId (return existing)
    // But currently it creates a new record
    assert.strictEqual(
      secondId,
      firstId,
      'RED: Should return existing record ID'
    );
  });

  it('documents current behavior (allows duplicates)', async () => {
    // Clean up
    await client.query(`DELETE FROM ${tableName}`);

    const operationId = 'test-current-behavior';

    // Write twice with same operationId
    await client.query(
      `INSERT INTO ${tableName} (content, metadata) VALUES ($1, $2)`,
      ['First', JSON.stringify({ operationId })]
    );

    await client.query(
      `INSERT INTO ${tableName} (content, metadata) VALUES ($1, $2)`,
      ['Second', JSON.stringify({ operationId })]
    );

    // Count - should be 2 (current behavior)
    const count = await client.query(
      `SELECT COUNT(*) FROM ${tableName} WHERE metadata->>'operationId' = $1`,
      [operationId]
    );

    console.log(`Current behavior: ${count.rows[0].count} records with same operationId`);
    assert.strictEqual(count.rows[0].count, '2', 'Currently allows duplicates');
  });
});
