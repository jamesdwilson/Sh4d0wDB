/**
 * ShadowDB Test Helpers
 *
 * Fixture setup and assertion utilities for baseline tests.
 */

export const TEST_CATEGORIES = {
  CATEGORY: 'test',
} as const;

export const MOCK_RESULTS = {
  searchMatch: {
    id: 1,
    path: 'shadowdb//test/d1',
    content: 'Test search result',
    category: 'test',
  },
  atomRecord: {
    id: 2,
    path: 'shadowdb//test/d2',
    content: 'Test atom record',
    category: 'test',
  },
} as const;

export function assertOperation(
  operation: string,
  result: any
) {
  if (!result || typeof result !== 'object') {
    throw new Error(`Expected result object for ${operation}`);
  }
  if (typeof result.ok !== 'boolean') {
    throw new Error(`Expected result.ok boolean for ${operation}`);
  }
}

export function assertPath(
  expectedPattern: RegExp,
  actualPath?: string,
) {
  if (!actualPath) {
    throw new Error('Path is required');
  }
  if (!expectedPattern.test(actualPath)) {
    throw new Error(`Path ${actualPath} does not match expected pattern`);
  }
}
