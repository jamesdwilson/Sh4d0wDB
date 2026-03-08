/**
 * linkedin-browser-client.mjs — Production BrowserClient for LinkedIn scraping
 *
 * Launches system Chrome via Playwright using the existing user profile so
 * LinkedIn session cookies are already present — no login, no cookie copying.
 *
 * Usage: imported by ingest.mjs when --source linkedin is requested.
 *
 * Design notes:
 *   - Uses system Chrome (not Playwright Chromium) with --user-data-dir pointing
 *     at the real Chrome profile — session is already authenticated
 *   - Chrome must not have the Default profile open in another window when this
 *     runs (Chrome locks the profile). Use --visible + a different profile if needed.
 *   - Single page instance reused across all navigations (no tab churn)
 *   - All evasion hooks live here, not in LinkedInFetcher — fetcher stays pure/testable
 *   - Must call .close() after use to release the browser process
 *
 * Evasion notes (stubs — not fully implemented):
 *   - User agent matches real Chrome
 *   - Viewport randomized slightly per session
 *   - scrollToBottom uses incremental scroll (human-like)
 *   - Mouse movement simulation is a stub (no-op until needed)
 */

import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";

// System Chrome executable
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Existing Chrome user data dir — session cookies already here, no copying needed
const CHROME_USER_DATA = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
const CHROME_PROFILE   = "Default";

// Real Chrome UA — avoids headless detection
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

/**
 * Create a production BrowserClient backed by Playwright Chromium.
 * Reuses Chrome session cookies so LinkedIn auth is already present.
 *
 * @param {object} opts
 * @param {boolean} [opts.headless=true]  - Run headless (default) or visible
 * @param {function} [opts.log]           - Logger function (default: console.log)
 * @returns {Promise<{ browser: BrowserClient, close: () => Promise<void> }>}
 */
export async function createLinkedInBrowserClient({ headless = true, log = console.log } = {}) {
  // Randomize viewport slightly — bots have identical viewports
  const width  = 1280 + Math.floor(Math.random() * 80);
  const height = 800  + Math.floor(Math.random() * 60);

  // Launch system Chrome with the real user profile — session already authenticated.
  // Chrome must not have this profile open in another window (profile lock).
  const context = await chromium.launchPersistentContext(
    path.join(CHROME_USER_DATA, CHROME_PROFILE),
    {
      executablePath: CHROME_EXECUTABLE,
      headless,
      userAgent: USER_AGENT,
      viewport: { width, height },
      locale: "en-US",
      timezoneId: "America/Chicago",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    },
  );

  const page = await context.newPage();

  // Hide webdriver flag (basic anti-detection)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const client = {
    async navigate(url) {
      log(`[linkedin-browser] navigate → ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    },

    async getPageSource() {
      return page.content();
    },

    async getCurrentUrl() {
      return page.url();
    },

    async waitForSelector(selector, timeoutMs = 10_000) {
      await page.waitForSelector(selector, { timeout: timeoutMs });
    },

    /**
     * Scroll to page bottom incrementally.
     * Incremental scroll looks more human than jumping to document.body.scrollHeight.
     * Stub: currently just calls a single smooth scroll. Full human-scroll
     * implementation (random pause between scroll steps) can be added here
     * when evasion.humanScroll is needed.
     */
    async scrollToBottom() {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let totalScrolled = 0;
          const step = 300 + Math.floor(Math.random() * 200);
          const interval = setInterval(() => {
            window.scrollBy(0, step);
            totalScrolled += step;
            if (totalScrolled >= document.body.scrollHeight) {
              clearInterval(interval);
              resolve();
            }
          }, 120);
        });
      });
    },

    /**
     * Inject data-thread-id onto each li.msg-conversation-listitem
     * by navigating to each thread and reading window.location.href.
     *
     * Strategy: LinkedIn thread cards don't expose the threadId in static HTML.
     * We click each card, read the resulting URL, then navigate back.
     * This is slow (N round-trips) so we cap at sessionBatchLimit.
     *
     * TODO(evasion): add random delay between clicks, random mouse movement
     * before each click to look more human.
     *
     * @param {number} limit - Max number of threads to annotate
     * @param {number} delayMs - Base delay between clicks
     */
    async injectThreadIds(limit = 20, delayMs = 2_000) {
      log(`[linkedin-browser] injecting thread IDs (limit: ${limit})`);
      const count = await page.evaluate(count => {
        return document.querySelectorAll("li.msg-conversation-listitem").length;
      }, limit);
      log(`[linkedin-browser] found ${count} thread items`);

      const items = await page.locator("li.msg-conversation-listitem").all();
      const capped = items.slice(0, limit);

      for (let i = 0; i < capped.length; i++) {
        try {
          // Click to navigate to the thread
          await capped[i].click({ timeout: 5_000 });

          // Wait for URL to change to a thread URL
          await page.waitForURL(/messaging\/thread\//, { timeout: 8_000 });
          const url = page.url();
          const match = url.match(/messaging\/thread\/([^/]+)/);
          const threadId = match?.[1];

          if (threadId) {
            // Annotate the li in the DOM (it persists across navigation for SPA)
            await page.evaluate(
              ({ idx, tid }) => {
                const items = document.querySelectorAll("li.msg-conversation-listitem");
                if (items[idx]) items[idx].setAttribute("data-thread-id", tid);
              },
              { idx: i, tid: threadId },
            );
          }

          // Navigate back to inbox
          await page.goto("https://www.linkedin.com/messaging/", {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          await page.waitForSelector("li.msg-conversation-listitem", { timeout: 8_000 });

          // Jittered delay (±30%)
          if (delayMs > 0) {
            const jitter = 1 + (Math.random() * 0.6 - 0.3);
            await new Promise(r => setTimeout(r, Math.round(delayMs * jitter)));
          }
        } catch (err) {
          log(`[linkedin-browser] warn: thread ${i} inject failed — ${err.message}`);
        }
      }
    },
  };

  return {
    browser: client,
    close: async () => {
      await context.close();
    },
  };
}
