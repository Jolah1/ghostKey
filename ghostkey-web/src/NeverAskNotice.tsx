/**
 * What GhostKey will never ask for (#392).
 *
 * A fake claim page or message only works if it gets one of these: the
 * heir's words, a wallet password, a fee, or control of their device.
 * GhostKey needs none of them, so saying so up front leaves a scam
 * nothing to take, even one we never see.
 */
import { useVocab } from "./vocab";

export function NeverAskNotice() {
  const n = useVocab().claim.neverAsk;
  return (
    <aside className="card-flat mb-6 p-5" aria-label={n.title}>
      <p className="text-sm font-semibold">{n.title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
        {n.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm font-semibold">{n.closing}</p>
    </aside>
  );
}
