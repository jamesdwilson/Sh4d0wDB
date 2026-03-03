#!/usr/bin/env node

/**
 * Simple baseline test for ShadowDB core operations
 * Tests: memory_write, memory_update, memory_search, memory_get
 */

async function testMemoryWrite() {
  console.log('Testing memory_write...');
  try {
    const result = await memory_write({
      content: 'Baseline test fact: Operation executed on 2026-03-03 07:06 CST',
      category: 'test',
    });

    console.log('OK memory_write result:', {
      ok: result.ok,
      id: result.id,
      path: result.path,
      operation: result.operation,
    });

    if (!result.ok || !result.id || !result.path || result.operation !== 'write') {
      console.error('FAILED memory_write validation');
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR memory_write:', error.message);
    process.exit(1);
  }
}

async function testMemoryUpdate() {
  console.log('Testing memory_update...');
  try {
    const created = await memory_write({
      content: 'Original content for update test',
      category: 'test',
    });

    const result = await memory_update({
      id: created.id,
      content: 'Updated content: Baseline test fact was successful',
      metadata: { updated: true },
    });

    console.log('OK memory_update result:', {
      ok: result.ok,
      operation: result.operation,
      path: result.path,
    });

    if (!result.ok || result.operation !== 'update') {
      console.error('FAILED memory_update validation');
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR memory_update:', error.message);
    process.exit(1);
  }
}

async function testMemorySearch() {
  console.log('Testing memory_search...');
  try {
    await memory_write({
      content: 'Search test result A - matching keyword',
      category: 'search_test',
    });
    await memory_write({
      content: 'Search test result B - matching keyword',
      category: 'search_test',
    });

    const result = await memory_search({
      query: 'test',
      category: 'search_test',
    });

    console.log('OK memory_search result:', {
      ok: result.ok,
      resultCount: result.results?.length || 0,
    });

    if (!result.ok || !result.results || result.results.length !== 2) {
      console.error('FAILED memory_search validation - expected 2 results');
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR memory_search:', error.message);
    process.exit(1);
  }
}

async function testMemoryGet() {
  console.log('Testing memory_get...');
  try {
    const created = await memory_write({
      content: 'Content for memory_get test',
      category: 'test',
    });

    const result = await memory_get({
      path: created.path,
    });

    console.log('OK memory_get result:', {
      ok: result.ok,
      operation: result.operation,
      hasContent: typeof result.content === 'string' && result.content.length > 0,
    });

    if (!result.ok || typeof result.content !== 'string' || result.content.length === 0) {
      console.error('FAILED memory_get validation');
      process.exit(1);
    }
  } catch (error) {
    console.error('ERROR memory_get:', error.message);
    process.exit(1);
  }
}

async function main() {
  console.log('=== ShadowDB Baseline Tests ===');
  console.log('');

  await testMemoryWrite();
  console.log('');
  await testMemoryUpdate();
  console.log('');
  await testMemorySearch();
  console.log('');
  await testMemoryGet();

  console.log('');
  console.log('=== All baseline tests PASSED ===');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
