/**
 * ShadowDB Baseline Unit Tests
 *
 * Core CRUD smoke tests — verifies end-to-end operations work.
 */

import { describe, it, expect } from 'vitest';

describe('Memory Baseline Tests', () => {
  describe('memory_write', () => {
    it('should insert a new record with required fields', async () => {
      // Write a test record
      const result = await memory_write({
        content: 'Test fact: Meeting happened on 2026-03-03',
        category: 'test',
      });

      expect(result.ok).toBe(true);
      expect(result.operation).toBe('write');
      expect(result.id).toBeGreaterThan(0);
      expect(result.path).toMatch(/^shadowdb\//test\/\d+$/);
    });

    it('should accept metadata JSONB, priority, parent_id', async () => {
      const result = await memory_write({
        content: 'Test fact',
        category: 'test',
        metadata: { testKey: 'testValue' },
        priority: 7,
        parent_id: 123,
      });

      expect(result.ok).toBe(true);
      expect(result.id).toBeGreaterThan(0);
      // Metadata should be stored as JSONB
      // Note: We can't easily verify metadata structure without memory_get
    });

    it('should accept record_type parameter', async () => {
      const result = await memory_write({
        content: 'Test fact',
        category: 'test',
        record_type: 'atom',
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('memory_update', () => {
    it('should update an existing record', async () => {
      // First create a record
      const created = await memory_write({
        content: 'Original content',
        category: 'test',
      });

      const result = await memory_update({
        id: created.id!,
        content: 'Updated content',
      });

      expect(result.ok).toBe(true);
      expect(result.operation).toBe('update');
      expect(result.path).toBe(created.path);
    });

    it('should update partial fields (metadata only)', async () => {
      const created = await memory_write({
        content: 'Original content',
        category: 'test',
      });

      const result = await memory_update({
        id: created.id!,
        metadata: { updated: true },
      });

      expect(result.ok).toBe(true);
    });
  });

  describe('memory_search', () => {
    it('should return results with required fields', async () => {
      // Write some test records
      await memory_write({ content: 'Fact A', category: 'search_test' });
      await memory_write({ content: 'Fact B', category: 'search_test' });

      const result = await memory_search({
        query: 'test',
      });

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(2);
      expect(result.results[0]).toHaveProperty('content');
      expect(result.results[0]).toHaveProperty('path');
    });

    it('should respect category filter', async () => {
      await memory_write({ content: 'Cat A', category: 'cat_a' });
      await memory_write({ content: 'Cat B', category: 'cat_b' });

      const result = await memory_search({
        query: 'test',
        category: 'cat_a',
      });

      expect(result.ok).toBe(true);
      expect(result.results.length).toBe(1);
      expect(result.results[0].content).toContain('Cat A');
    });
  });

  describe('memory_get', () => {
    it('should retrieve a full record by path', async () => {
      const created = await memory_write({
        content: 'Full record content for retrieval test',
        category: 'test',
      });

      const result = await memory_get({
        path: created.path!,
      });

      expect(result.ok).toBe(true);
      expect(result.operation).toBe('get');
      expect(result.content).toContain('Full record content for retrieval test');
    });

    it('should retrieve specific section by metadata.section_name', async () => {
      // Create a document with sections
      const doc = await memory_write({
        content: 'Document content',
        category: 'test',
        metadata: { section_name: 'psych_profile' },
      });

      // Create a section
      const section = await memory_write({
        content: 'Psych profile content',
        category: 'test',
        parent_id: doc.id!,
        metadata: { section_name: 'psych_profile' },
      });

      const result = await memory_get({
        path: section.path!,
        section: 'psych_profile',
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain('Psych profile content');
    });
  });
});
