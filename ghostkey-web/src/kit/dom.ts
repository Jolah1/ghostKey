/** Tiny vanilla-DOM helpers shared by the recovery kit page and its
 *  spend panel. Kept framework-free so the inlined kit stays small and
 *  auditable. */

export function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A labelled monospace block with a copy button. */
export function copyBlock(label: string, value: string): HTMLElement {
  const node = el(`
    <div class="box">
      <p class="muted" style="margin-top:0">${esc(label)}</p>
      <p class="mono">${esc(value)}</p>
      <button class="copy" type="button">Copy</button>
    </div>
  `);
  const btn = node.querySelector("button")!;
  btn.addEventListener("click", () => {
    void navigator.clipboard.writeText(value).then(() => {
      btn.textContent = "Copied ✓";
      window.setTimeout(() => (btn.textContent = "Copy"), 1500);
    });
  });
  return node;
}
