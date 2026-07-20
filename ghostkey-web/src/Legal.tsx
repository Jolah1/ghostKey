/**
 * Legal pages: Terms of Service (#/terms) and Privacy Policy
 * (#/privacy).
 *
 * Both are static content sharing one layout and one lazy chunk.
 * The writing follows the same rule as the rest of the app: a
 * non-technical reader should understand every paragraph. Each page
 * opens with a plain-English summary card; the numbered sections
 * below it are the actual terms.
 *
 * Operator identity, contact address, and governing law are
 * constants below so a company change is a one-line edit. These
 * pages were drafted by the team, not by a lawyer — have counsel
 * review before scale.
 */

import type { ReactNode } from "react";

const OPERATOR = "GhostKey App Limited";
const SUPPORT_EMAIL = "support@ghostkeyapp.com";
const GOVERNING_LAW = "the Federal Republic of Nigeria";
const VENUE = "the courts of Lagos State, Nigeria";
const EFFECTIVE_DATE = "June 12, 2026";

/* ------------------------------ shared layout ----------------------------- */

function LegalLayout({
  eyebrow,
  title,
  summary,
  children,
}: {
  eyebrow: string;
  title: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="bg-app fade-in">
      <div className="mx-auto max-w-2xl px-5 py-16 md:py-20">
        <p className="eyebrow-tag">{eyebrow}</p>
        <h1 className="mt-3 font-serif text-4xl md:text-5xl">{title}</h1>
        <p className="mt-3 text-sm text-dim">Effective {EFFECTIVE_DATE}.</p>

        <section className="card-flat mt-8 p-5">
          <h2 className="text-sm font-semibold">The short version</h2>
          <div className="mt-1.5 space-y-2 text-sm text-muted">{summary}</div>
        </section>

        <div className="legal-body mt-10 space-y-10">{children}</div>

        <p className="mt-12 border-t border-app pt-6 text-sm text-dim">
          Questions? Email{" "}
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </div>
    </main>
  );
}

function Section({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold">
        {n}. {title}
      </h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted">
        {children}
      </div>
    </section>
  );
}

/* ---------------------------------- Terms --------------------------------- */

export function TermsPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Terms of Service"
      summary={
        <>
          <p>
            GhostKey schedules reminders and notifications around your
            Bitcoin. Our backend does not store your readable owner key or
            password. The published application is designed so the backend
            cannot recover them or move owner funds, but the hosted website
            remains trusted because it handles both in your browser. The one exception: on the easy
            heir setup we can unlock your heir's wallet to deliver a claim
            after the waiting period, and the advanced setup removes even
            that. You're responsible for your password and your recovery
            file. The service is provided as-is, free of charge, with no
            guarantees.
          </p>
        </>
      }
    >
      <Section n={1} title="Who we are">
        <p>
          The GhostKey service at www.ghostkeyapp.com is operated by{" "}
          {OPERATOR} ("GhostKey", "we", "us"). You can reach us at{" "}
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          . By using the service you agree to these terms.
        </p>
      </Section>

      <Section n={2} title="What GhostKey is, and is not">
        <p>
          GhostKey is a <strong>non-custodial</strong> scheduling and
          notification service for Bitcoin inheritance. It watches a
          check-in schedule you set, reminds you before deadlines, and,
          if you stop responding, sends the person you chose a link to
          claim your bitcoin. The rules that actually control your funds
          live on the Bitcoin network, not on our servers. One detail to
          be honest about: if you let us make your heir a wallet from
          their email, we can unlock that wallet to deliver a claim once
          your waiting period has passed. If you'd rather we never be able
          to, use the advanced setup and give us only your heir's public
          key.
        </p>
        <p>
          We are <strong>not</strong> a bank, a custodian, an exchange, or
          a money transmitter. We never take possession of your bitcoin.
          We cannot move your funds, freeze them, seize them, or reverse a
          transaction. Nobody can reverse a Bitcoin transaction.
        </p>
        <p>
          GhostKey is also not a legal will and not legal, tax, or
          financial advice. If you need estate planning beyond passing
          bitcoin to one person, talk to a professional.
        </p>
      </Section>

      <Section n={3} title="What you are responsible for">
        <p>
          Because our backend does not hold your readable owner key, some
          things are only yours to do. The hosted website is still trusted
          code: it handles your key and password briefly in your browser.
        </p>
        <ul role="list" className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Your password.</strong> Our backend does not receive or
            store it and cannot reset it. The website code handles it in
            your browser while locking or unlocking your key. Your recovery file opens with this same password, so
            it cannot rescue a forgotten one. If you forget your password,
            the funds remain reachable only through the inheritance path:
            your heir's claim, or your own copy of your heir's file once
            the waiting period has passed.
          </li>
          <li>
            <strong>Your emergency recovery file.</strong> Keep a copy
            somewhere safe. It is your guaranteed way to your funds even
            if GhostKey disappears.
          </li>
          <li>
            <strong>Your heir's contact details.</strong> If the email
            address you gave us is wrong, abandoned, or controlled by
            someone else, the claim link goes to the wrong place. Keep it
            current, and choose it as carefully as you'd choose where to
            mail a house key.
          </li>
          <li>
            <strong>Checking in.</strong> If you miss your check-ins and
            the grace period passes, the claim process starts. That is the
            product working as designed.
          </li>
        </ul>
      </Section>

      <Section n={4} title="Service is best-effort">
        <p>
          GhostKey is early software. We aim for high availability, but we
          do not guarantee uptime, and reminders depend on third-party
          delivery (email providers, spam filters, Lightning
          infrastructure) that we don't control. We may change, add, or
          remove features. If we ever discontinue the service, your
          bitcoin remains accessible without us (that is the point of the
          recovery file), and we will give reasonable notice.
        </p>
      </Section>

      <Section n={5} title="Fees">
        <p>
          The service is currently free. If we ever introduce paid plans,
          one rule is permanent: <strong>claiming your bitcoin and
          accessing your funds on-chain will never be gated behind
          payment.</strong> A missed subscription will never lock anyone
          away from their money.
        </p>
      </Section>

      <Section n={6} title="Acceptable use">
        <p>
          Use the service only for lawful purposes and only for bitcoin
          you have the right to control. Don't probe, overload, or attack
          the service, and don't use it to harass anyone. We may rate-limit
          or suspend abusive access; even then, on-chain access to funds is
          unaffected.
        </p>
      </Section>

      <Section n={7} title="No warranties; limitation of liability">
        <p>
          The service is provided "as is" and "as available", without
          warranties of any kind, express or implied. To the maximum
          extent permitted by law, {OPERATOR} is not liable for indirect,
          incidental, special, or consequential damages, or for loss of
          funds arising from lost passwords or recovery files, incorrect
          contact details, missed or delayed notifications, third-party
          failures, or your own transactions. Our total liability for any
          claim is limited to the amount you paid us in the twelve months
          before the claim (currently zero).
        </p>
        <p>
          Some jurisdictions don't allow certain limitations; where that's
          the case, these limits apply to the fullest extent permitted.
        </p>
      </Section>

      <Section n={8} title="Ending things">
        <p>
          You can delete your vault from the dashboard at any time, which
          removes your data from our servers (see the{" "}
          <a className="underline" href="#/privacy">
            Privacy Policy
          </a>
          ). Deleting your vault does not move or affect your bitcoin.
          It only stops our reminders and the claim-link delivery.
        </p>
      </Section>

      <Section n={9} title="Changes to these terms">
        <p>
          We may update these terms as the service evolves. Material
          changes will be announced on the site with an updated effective
          date. Continuing to use the service after a change means you
          accept the new terms.
        </p>
      </Section>

      <Section n={10} title="Governing law">
        <p>
          These terms are governed by the laws of {GOVERNING_LAW},
          without regard to conflict-of-law rules. Any dispute that
          cannot be resolved informally will be heard in {VENUE}.
        </p>
      </Section>
    </LegalLayout>
  );
}

/* --------------------------------- Privacy -------------------------------- */

export function PrivacyPage() {
  return (
    <LegalLayout
      eyebrow="Legal"
      title="Privacy Policy"
      summary={
        <>
          <p>
            We store your check-in schedule and the contact details you
            give us, encrypted. Our backend does not store your readable
            password or owner spending key. The hosted website does handle
            both briefly in browser memory. One exception: on the easy heir
            setup we hold your heir's key, locked, so we can deliver their
            claim after the waiting period; the advanced setup removes even
            that. No ads, no tracking cookies, no selling data. Delete your
            vault and the data goes with it.
          </p>
        </>
      }
    >
      <Section n={1} title="Who is responsible for your data">
        <p>
          {OPERATOR} operates the GhostKey service at www.ghostkeyapp.com
          and is the data controller for the information described here.
          Contact:{" "}
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Section>

      <Section n={2} title="What we store">
        <ul role="list" className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Your vault's schedule</strong>: its label, check-in
            cadence, deadlines, and which Bitcoin network it's on.
          </li>
          <li>
            <strong>Watch-only wallet data</strong>: descriptors that let
            our server see the vault's balance and build transactions for
            you to authorize. They cannot spend anything.
          </li>
          <li>
            <strong>Contact details</strong>: your email, your heir's,
            and your optional trusted contact's, stored{" "}
            <strong>encrypted at rest</strong>. Your heir receives nothing
            from us until your schedule actually triggers.
          </li>
          <li>
            <strong>Sealed key backups</strong>: owner-key blobs need your
            password. In the simple no-wallet heir setup, the heir-key blob
            uses a claim token that we retain encrypted so we can deliver it
            later; our database plus production master key can recover it.
            The heir-controlled-key option sends us no heir private key.
          </li>
          <li>
            <strong>Activity records</strong>: check-ins, reminders sent,
            and Lightning check-in invoices, so your dashboard can show
            history.
          </li>
        </ul>
      </Section>

      <Section n={3} title="What we never store">
        <p>
          Our backend database does not store your readable password,
          unencrypted private keys, tracking cookies, or browsing profiles.
          Passwords and keys do exist briefly in browser memory when the
          website creates or unlocks them. Our site analytics are anonymous daily counters
          ("how many people visited the setup page today") with no IP
          address, no cookie, and no fingerprint attached.
        </p>
      </Section>

      <Section n={4} title="How we use it">
        <p>
          For exactly one purpose: running your inheritance schedule,
          showing your dashboard, sending your reminders, and delivering
          the claim link if the time comes. We don't sell data, share it
          for advertising, or use it for anything unrelated to the
          service.
        </p>
      </Section>

      <Section n={5} title="Service providers we rely on">
        <p>Running the service involves a few companies, each seeing only what its job requires:</p>
        <ul role="list" className="list-disc space-y-1.5 pl-5">
          <li>
            <strong>Resend</strong> delivers our emails, so it processes
            recipient addresses and message contents in transit.
          </li>
          <li>
            <strong>Fly.io</strong> hosts our server; <strong>Vercel</strong>{" "}
            hosts this website. Because Vercel delivers the JavaScript that
            handles keys in your browser, the hosted frontend and its
            deployment account are trusted security components.
          </li>
          <li>
            <strong>Cloudflare</strong> stores our database backups,
            which contain only the encrypted data described above.
          </li>
          <li>
            <strong>Anthropic</strong> processes what you type into the AI
            setup guide, only if you choose to use it. Don't paste
            passwords or keys into the chat. It will tell you the same.
          </li>
          <li>
            <strong>Bitcoin and Lightning infrastructure</strong>: our
            server queries public block explorers about vault addresses
            and processes Lightning check-in payments. Bitcoin itself is a
            public network: anyone can see transactions on it.
          </li>
        </ul>
      </Section>

      <Section n={6} title="How long we keep it, and how to delete it">
        <p>
          We keep your data while your vault exists. Deleting your vault
          from the dashboard removes it from our live database, including
          its activity history; encrypted backups age out on a rolling
          window afterwards. Deleting your vault never touches your
          bitcoin. It stays on the Bitcoin network under your keys.
        </p>
        <p>
          You can also email{" "}
          <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>{" "}
          to ask what we hold about you or to request deletion.
        </p>
      </Section>

      <Section n={7} title="On-device storage">
        <p>
          Your browser keeps a small amount of GhostKey data locally (such
          as which vault this device manages and your theme choice) so the
          app works between visits. That data stays on your device and is
          yours to clear.
        </p>
      </Section>

      <Section n={8} title="Children">
        <p>
          The service is for adults. Your heir may be a minor. In that
          case, the heir contact details you give us should belong to a
          trusted adult (a guardian) who can act when the time comes.
        </p>
      </Section>

      <Section n={9} title="Changes">
        <p>
          If this policy changes materially, we'll announce it on the site
          with a new effective date.
        </p>
      </Section>
    </LegalLayout>
  );
}
