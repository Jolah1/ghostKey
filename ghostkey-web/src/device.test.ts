import { afterEach, describe, expect, it, vi } from "vitest";

/** Minimal stand-ins for the browser objects device.ts touches. */
function fakeBrowser(opts: { controller: boolean; visible: boolean }) {
  const sw = Object.assign(new EventTarget(), {
    controller: opts.controller ? {} : null,
    register: vi.fn(async () => ({ update: vi.fn(async () => undefined) })),
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: opts.visible ? "visible" : "hidden" });
  const reload = vi.fn();
  const win = Object.assign(new EventTarget(), { location: { reload }, setInterval: vi.fn() });
  vi.stubGlobal("navigator", { serviceWorker: sw });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  return { sw, doc, win, reload };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("watchForUpdates", () => {
  it("doesn't reload on the very first install", async () => {
    const b = fakeBrowser({ controller: false, visible: true });
    (await import("./device")).watchForUpdates();
    b.sw.dispatchEvent(new Event("controllerchange"));
    b.win.dispatchEvent(new Event("hashchange"));
    expect(b.reload).not.toHaveBeenCalled();
  });

  it("waits for a safe moment (a page change) instead of reloading mid-typing", async () => {
    const b = fakeBrowser({ controller: true, visible: true });
    (await import("./device")).watchForUpdates();
    b.sw.dispatchEvent(new Event("controllerchange"));
    expect(b.reload).not.toHaveBeenCalled();
    b.win.dispatchEvent(new Event("hashchange"));
    expect(b.reload).toHaveBeenCalledTimes(1);
    b.win.dispatchEvent(new Event("hashchange"));
    expect(b.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads straight away when the app is in the background", async () => {
    const b = fakeBrowser({ controller: true, visible: false });
    (await import("./device")).watchForUpdates();
    b.sw.dispatchEvent(new Event("controllerchange"));
    expect(b.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when the app comes back to the screen", async () => {
    const b = fakeBrowser({ controller: true, visible: true });
    (await import("./device")).watchForUpdates();
    b.sw.dispatchEvent(new Event("controllerchange"));
    b.doc.dispatchEvent(new Event("visibilitychange"));
    expect(b.reload).toHaveBeenCalledTimes(1);
  });
});
