/**
 * Wait for running CSS animations to finish. Pages fade in from opacity
 * 0 (`.fade-in`, 0.35s), and an accessibility scan taken mid-fade reads
 * half-transparent text as failing colour contrast. On a slow CI runner
 * that made the a11y checks flaky.
 */
import type { Page } from "@playwright/test";

export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
}
