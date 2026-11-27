/**
 * "How does this work?": the explanations that used to crowd Home and
 * setup, in one place, one question at a time.
 */
import type { Route } from "./App";
import { FAQS } from "./faq";
import { PageShell } from "./PageShell";
import { Disclosure } from "./ui";

export function HelpPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  return (
    <PageShell title="How does this work?" onNavigate={onNavigate}>
      <div className="space-y-3">
        {FAQS.map((item) => (
          <Disclosure key={item.q} summary={<span className="font-medium">{item.q}</span>}>
            <p className="text-sm leading-relaxed text-muted">{item.a}</p>
          </Disclosure>
        ))}
      </div>
    </PageShell>
  );
}
