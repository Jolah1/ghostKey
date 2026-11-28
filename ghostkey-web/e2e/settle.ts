/**
 * Wait for running CSS animations to finish. Pages fade in from opacity
 * 0 (`.fade-in`, 0.35s), and an accessibility scan taken mid-fade reads
 * half-transparent text as failing colour contrast. On a slow CI runner
 * that made the a11y checks flaky.
 */
import type { Page } from "@playwright/test";

export async function settleAnimations(page: Page): Promise<void> {
  // Looping animations (a floating card, a pulsing dot) never finish, so
  // only wait for the ones that end.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}
