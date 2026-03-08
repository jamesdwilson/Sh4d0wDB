/**
 * linkedin-browser-client.mjs — Production BrowserClient for LinkedIn scraping
 *
 * Wraps Playwright Chromium with a persistent context that reuses the local
 * Chrome profile so LinkedIn session cookies are already present — no login.
 *
 * Usage: imported by ingest.mjs when --source linkedin is requested.
 *
 * Design notes:
 *   - Uses chromium (not system Chrome) to avoid locking the user's browser
 *   - Copies cookies from Chrome profile into Playwright context at startup
 *   - Single page instance reused across all navigations (no tab churn)
 *   - All evasion hooks (mouse movement, human scroll) live here, not in the
 *     LinkedInFetcher — keeps the fetcher pure and testable
 *   - Must call .close() after use to release the browser process
 *
 * Evasion notes (stubs — not fully implemented):
 *   - User agent is set to a real Chrome UA string
 *   - Viewport randomized slightly per session
 *   - scrollToBottom uses incremental scroll with small delays (human-like)
 *   - Mouse movement simulation is a stub (no-op until needed)
 */

import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Chrome profile path — where session cookies live
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

  // Launch persistent context pointing at a temp copy of Chrome profile.
  // We copy the cookies DB only (not the full profile) to avoid conflicts
  // with a running Chrome instance.
  const sessionDir = await buildSessionDir(log);

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless,
    userAgent: USER_AGENT,
    viewport: { width, height },
    locale: "en-US",
    timezoneId: "America/Chicago",
    // Suppress automation flags
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

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
      // Clean up temp session dir
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Build a minimal Playwright session directory with Chrome cookies copied in.
 * We only copy the Cookies SQLite file — not the full multi-GB profile.
 * This avoids "profile already in use" errors when Chrome is running.
 */
async function buildSessionDir(log) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-pw-"));
  const profileDir = path.join(tmpDir, "Default");
  fs.mkdirSync(profileDir, { recursive: true });

  const cookiesSrc = path.join(CHROME_USER_DATA, CHROME_PROFILE, "Cookies");
  const cookiesDst = path.join(profileDir, "Cookies");

  if (fs.existsSync(cookiesSrc)) {
    try {
      fs.copyFileSync(cookiesSrc, cookiesDst);
      log(`[linkedin-browser] copied Chrome cookies from ${cookiesSrc}`);
    } catch (err) {
      log(`[linkedin-browser] warn: could not copy Chrome cookies (${err.message}) — will need manual login`);
    }
  } else {
    log(`[linkedin-browser] warn: Chrome cookies not found at ${cookiesSrc} — will need manual login`);
  }

  return tmpDir;
}
