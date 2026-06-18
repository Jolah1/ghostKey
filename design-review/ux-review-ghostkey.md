## Bitcoin UX Review

GhostKey. Heartbeat based Bitcoin inheritance. Mobile first web app on Bitcoin mainnet.

Reviewed flows: landing page, vault setup (heir and timing), sign in, owner dashboard, recovery kit, heir inherit entry, and the emergency recovery file.

### Review framework

1. Mistakes are permanent. Unlike a bank transfer, a Bitcoin transaction cannot be reversed, so the design must prevent errors before they happen rather than recovering from them after.
2. Trust is everything. Every screen must answer the user's unspoken question: is my money safe, can I go back, and is everything okay?
3. Onboarding is a crisis point. The first time someone uses a Bitcoin wallet is the moment they are most likely to make a serious mistake, so the first run experience must be exceptionally careful and gentle.
4. Jargon kills adoption. Words like peers, node, mempool and UTXO are normal to developers but meaningless to most users, and every jargon word in the main flow is a person who gives up and leaves.
5. Progressive disclosure. Show beginners the simple version and hide advanced controls until they are actually needed, so the app works for both a first timer and a power user without overwhelming either.
6. Extreme user range. Bitcoin wallets are used by complete beginners and highly technical sovereignty focused users, and the design must work for both ends of that spectrum without patronising one or overwhelming the other.
7. Invisible tech, visible state. The user should never need to understand the technology underneath, but they should always know exactly what is happening right now: did it work, is it pending, or did something fail?
8. Security vs usability tension. Every confirmation step and friction point should earn its place by genuinely protecting the user, not just adding annoying steps that train people to click through without reading.
9. Education is part of the UX. There is no support team to call, so the app itself must teach people as they go through tooltips, loading screen copy, and contextual explanations rather than hiding help in external documentation.
10. Password Protection. There is no central authority who can reset anything. If someone loses their seed phrase, their bitcoin is gone permanently. The design has to make users understand this responsibility from the very beginning, without terrifying them into giving up.

### First impressions

The voice is the strongest thing GhostKey has. Lines like "Tap once a month to say you're here" and "Your people get what you left them" are warm, plain, and human. This is rare in Bitcoin products and it is a real asset. The core metaphor, a heartbeat that keeps your Bitcoin alive, is clear and emotionally honest. The dark visual language is cohesive across the marketing pages, the single teal accent is used with discipline, and the typographic hierarchy reads well.

Where the product wobbles is at the exact moments that matter most for a money app: the live state on the dashboard, the raw activity labels, a developer banner that leaked into the real product, and one badge that tells the owner their heir is "Ready to claim" while the owner is alive and checked in. None of these are hard to fix. All of them touch trust directly.

There is also a tone split. The setup and dashboard speak softly and carefully. The comparison page ("Nothing else comes close") and the footer tagline ("programmable self-custody continuity for Bitcoin") jump into a louder, more technical register. Picking one voice and holding it everywhere will make the product feel like one thing.

The most important gap is emotional. Your highest stakes user, the grieving heir, currently meets the coldest, most technical screens in the whole product. We will weight that heavily below.

### Findings ordered by screen

#### Global: the mainnet banner

Copy at the very top of several pages: "Mainnet: GhostKey is running on Bitcoin mainnet. Real money is in scope. Confirm your security review is complete."

Principle 2 and Principle 7. This reads as an internal staging or developer banner that has reached the live product. "Real money is in scope" and "Confirm your security review is complete" are engineering phrases. To an owner this sounds like a warning that the app is not finished and not safe, which is the opposite of what we want on the first screen they see. We could either remove this for end users or replace it with a calm, plain confidence line, for example "You are on the live Bitcoin network. Your funds are real." The current wording quietly damages trust on every page it appears.

#### Landing hero

Copy: "Your Bitcoin lives on after you" with "Set up once. Tap once a month to say you're here. If you ever stop, the people you chose can claim what's theirs."

Principle 4 and Principle 7. The headline and subhead are excellent. The trust strip below is weaker: "0 THIRD PARTIES", "100% NON-CUSTODIAL", "On-chain GUARANTEED". "NON-CUSTODIAL" and "On-chain GUARANTEED" are insider terms that the target owner half understands and a future heir will not. We could keep the format and translate the words, for example "We never hold your keys", "No company can freeze it", "Runs on Bitcoin itself". Same reassurance, no jargon.

Principle 6. "Vault" is used everywhere as the core noun. For a Bitcoin saver it lands fine. Keep an eye on it for the heir side, where "vault" may not be obvious. This is acceptable as the product metaphor as long as the heir flow never assumes the heir already knows the word.

#### How it works

Copy: "Connect a Bitcoin wallet and choose who inherits. About five minutes. No documents, no lawyers, no terminal commands."

Principle 4. This section is strong and plain. One small note: "no terminal commands" reassures a fear that a non technical owner did not have, and names a thing they do not recognise. We could swap it for "nothing technical to install". Step two, "That's the whole job", is a great line. Keep it.

#### Vault lifecycle

Copy: CREATED, ACTIVE, GRACE, CLAIMABLE, CLOSED, with "Always in control: You can reclaim everything at any moment before the heir claims."

Principle 7 and Principle 2. This is a clear mental model and the "Always in control" reassurance is well placed. "on-chain" appears here and reads as jargon in an otherwise plain section. We could say "once the waiting time has fully passed" instead of "after the waiting period passes on-chain". The stage names themselves are fine as a teaching device.

#### Why Bitcoin

Copy includes "On-chain timelocks using OP_CSV", "Taproot by default", "PSBT under the hood", "Recovering on your own... uses Bitcoin Core, which understands the vault's timelock script".

Principle 5 and Principle 6. This is the section for the sovereignty minded reader, and serving that reader is correct for an inheritance product where people want to verify the claims. The issue is placement and signposting, not the content. Right now the deep terms (OP_CSV, Taproot, PSBT, Bitcoin Core) sit at the same visual level as the plain marketing above. We could label this block clearly as the technical detail, for example a small "For the technically curious" heading, so a beginner knows they are allowed to skip it and a power user knows where to look. That is progressive disclosure done well rather than removing the depth.

#### Comparison table

Copy: "Nothing else comes close" with a GhostKey row marked "BEST".

Principle 2. The claim is fine to make, but the phrasing is louder and more boastful than the calm, trustworthy voice everywhere else, and on a money product overclaiming can read as less trustworthy, not more. We could soften the headline to something like "How GhostKey compares" and let the table do the talking. The footnote "Comparisons reflect each project's public documentation at time of writing" is a good, honest touch. Keep it.

#### Bottom call to action and footer

Copy: "Don't let your Bitcoin die with you" with buttons "Set up your vault" and "Read the docs". Footer tagline: "GhostKey is not a legal will. It is programmable self-custody continuity for Bitcoin."

Principle 4. "Read the docs" is developer language. Most owners do not think in "docs". "How it works" or "Learn more" fits the audience better. The footer tagline "programmable self-custody continuity" is the most jargon dense line in the whole product and it sits in the most permanent spot. The "not a legal will" clarification is valuable and should stay, but in plain words, for example "GhostKey is not a legal will. It is a way to make sure your family can reach your Bitcoin if you are gone."

#### Setup, step 1 of 3, heir

Copy: "Who should receive this. They never have to know about this until the time comes. When it does, we reach them on the channel you pick and they claim from a link. No wallet install, no setup on their end."

Principle 4. "the channel you pick" uses "channel" as a tech word. A reader may not connect "channel" to email, SMS, or WhatsApp. We could say "the way you choose to reach them" or "by email, text, or WhatsApp, your choice".

Principle 1 and Principle 10. The checkbox "They don't have a Bitcoin wallet yet. We'll generate one for them from their email when they open the claim link" is a genuinely thoughtful feature for non technical heirs and deserves more prominence, not less. Right now it is a small checkbox that visually collides with the next label "A SHORT NOTE FOR THEM (OPTIONAL)" with no spacing between them, which reads as a layout bug. Give it breathing room and consider making the "they have no wallet" path the default assumption, since most heirs will not have one.

Principle 3 and Principle 9. The right rail card "Nothing happens today. Your heir gets no message when you finish this" is exactly the right reassurance at the right moment. Excellent.

Principle 4. In the same right rail summary, "Slack if you miss one: 3 days". "Slack" used as a noun meaning spare time is informal and idiomatic, hard for a non native reader, and it also collides with the workplace app of the same name. We could say "Extra time if you miss one" or "Grace period".

Principle 4. "Stored encrypted. We don't message them until the alarm fires." "the alarm fires" is an idiom. Plainer: "We only contact them if you stop checking in."

Principle 9. The trust tip "tell this person, with no details, that if they ever hear from GhostKey it is real and from you. A quiet heads-up now makes the message easy to trust later" is great anti scam thinking and should stay. Only swap "heads-up" for "a quiet word now" so it translates cleanly.

#### Setup, timing controls

Copy: "IF YOU STOP CHECKING IN, WAIT THIS LONG BEFORE THEY CAN CLAIM" (3 months), "REMIND ME TO CHECK IN" (Every 2 weeks, recommended), "GRACE PERIOD AFTER A MISSED REMINDER" (3 days, recommended) with "Extra slack before the vault enters its alarm state."

Principle 4 and Principle 8. The plain English labels on the controls themselves are very good. Two phrases pull against that: "Extra slack" (idiom again) and "the vault enters its alarm state" (tech metaphor). We could write "Extra time before the countdown to inheritance begins. Your heir still cannot claim until the full waiting time above has passed." The "recommended" tags on the safe defaults are a good nudge.

Principle 5. "Already have a Bitcoin wallet you'd rather keep? Use the advanced flow to paste your own xpub instead." This is the right way to handle "xpub": hidden behind an explicit advanced path so beginners never see it and power users can find it. Well done.

Principle 7. The step counter says "STEP 1 OF 3" but this single step covers naming heirs, choosing claim timing, reminder cadence, grace period, and the funding method choice. That is a heavy step one. Either the counter or the grouping is off. We could break this into clearer sub steps or relabel so the progress indicator matches what the user actually experiences.

#### Sign in

Copy: "Open your vault on this device. Use the email and password you picked when you set the vault up. We unwrap your keys in this tab. Nothing leaves the browser."

Principle 4 and Principle 7. "Nothing leaves the browser" is a strong, plain privacy promise. Keep it. "We unwrap your keys in this tab" is the weak part: "unwrap your keys" is jargon and slightly alarming to a non technical reader who does not picture keys being wrapped. Plainer: "We unlock your vault right here on your device."

#### Owner dashboard

Copy: "You're still here. Last checked in 5 days ago. Next reminder in in 4 days." and "Already checked in. One check-in per period. The next one opens in in 1 day."

Principle 7. There is a doubled word, "in in", in at least two places. On a money product these small slips read as carelessness and quietly lower trust. Quick fix, high return.

Principle 2 and Principle 7. The biggest issue on this screen is the heir chip showing a green "Ready to claim" badge while the owner is alive and has just checked in. To an owner this strongly implies the heir can take the funds right now, which is the opposite of the truth and is frightening on an inheritance product. The state label must reflect reality, for example "Standing by", "Set up", or "Will be notified if you stop checking in". Reserve "Ready to claim" for the actual claimable state. This is the single most important correctness fix in the product.

Principle 7. The heir's name is truncated to "F..." in the chip. It looks broken and undermines the owner's confidence that the right person is named. Show the full name, or at least first name plus initial.

Principle 1 and Principle 10. "Confirm your email so reminders reach you. Resend" is shown as a quiet strip near the bottom. This is load bearing. If reminders never arrive because the email was never confirmed, the owner can miss check ins and trigger the inheritance process by accident. For the one mechanism that prevents a permanent mistake, this warning is far too quiet. We could raise it to a prominent banner until the email is confirmed, and explain the stakes in one plain line: "Until you confirm your email, we cannot remind you to check in."

Principle 4. The recent activity feed shows raw event codes: "owner_send", "lightning_invoice_issued", "Vault activated", "Checked in". "Checked in" and "Vault activated" are human. "owner_send" and "lightning_invoice_issued" are database labels. We could map every event to plain language, for example "You sent Bitcoin" and "Reminder check in paid".

Principle 7. The primary heartbeat button is disabled and labelled "Locked until next period" with "in 4 days before countdown begins" underneath. The intent (one check in per period) is sound, but the hero action of the dashboard being a dead button can confuse a returning user, and "before countdown begins" mixes calm reassurance with countdown anxiety. We could make the resting state clearly positive, for example a calm "You are all set. Next check in opens in 4 days", and only present the tappable heartbeat when it actually does something.

Principle 6. The balance shows "6,660 sat" with no fiat value. For a Bitcoin native owner this is fine. For broader reach, an optional local currency value would help the owner sense what is at stake. Low priority, but worth noting.

#### Recovery kit

Copy: "Your spare key. A backup of your key, for emergencies. Save a copy somewhere safe like your email or a USB stick. If you ever can't get into GhostKey, open it and type your password to reach your money."

Principle 9 and Principle 10. This is some of the best copy in the product. "Your spare key" is the perfect metaphor and the instructions are plain and calm. One improvement: after the download, confirm it worked and gently restate why it matters, since this file is what protects the owner if GhostKey ever disappears. A single line such as "Saved. Keep this somewhere you will still have access to in years to come" would close the loop.

#### Inherit, heir entry page

Copy: "You should have received a link. If someone named you as an heir, you'll receive a one-time link by SMS, WhatsApp, or email when the vault becomes claimable. Open that link on any device. There's no account to sign in to." Plus "WHAT THE LINK LOOKS LIKE" and "The bit after /claim/ is your one-time access token."

Principle 3. This is the heir's first run, and it is a crisis point at least as serious as owner onboarding, because the heir may be grieving, anxious, and new to Bitcoin. The page is honest and well structured, but it is cold. There is no acknowledgement of the human moment. We could open with one warm, plain line before the mechanics, for example "If you are here, someone trusted you to look after something they left behind. We will walk you through it slowly."

Principle 4. "one-time access token", "the bit after /claim/", and the raw URL example are developer framing on the screen meant for the least technical user in the whole product. We could keep the reassurance and drop the token vocabulary: "Your link is private and works only once. Do not share it." Show the example link if helpful, but do not ask the heir to understand what a token is.

Principle 2. The honesty of "Don't have a link yet? That's normal... there is nothing on this site for you to do" is genuinely good and prevents confusion. Keep it.

#### Emergency recovery file

Copy: "Your Bitcoin, Emergency Recovery File", "What this file is", "Where to keep it", "Unlock with your password", "Just want to check the money is there?", plus "Receive descriptor (watch-only)", "Change descriptor (watch-only)", and instructions referencing mempool.space, Bitcoin Core, descriptors, timelock, Sparrow, and Liana.

Principle 9 and Principle 10. The top half is excellent. "What this file is", "Where to keep it", and the explanation that unlocking is slow on purpose because "that slowness is what makes your password hard to crack" are exactly the kind of in context education this product needs. This is teaching at the right moment.

Principle 4 and Principle 6. The bottom half is the most jargon dense screen in the product: block explorer, deposit address, descriptor, Bitcoin Core version 26, timelock, 4,320 blocks, Sparrow, Liana, plus two raw descriptor strings. This is the correct fallback path for a technical helper assisting the heir when GhostKey is gone, so the content should exist. The risk is that a non technical heir lands here directly and panics. We could split the page clearly into two layers: a calm top layer for the heir ("Type your password and press Unlock, that is all you need"), and a clearly separated, collapsed lower layer headed "For a Bitcoin expert helping you" that holds the descriptors and the Bitcoin Core instructions. The line "any Bitcoin-savvy person can help using just this file" is the right framing and should lead that section. Translating "4,320 blocks" to "about 30 days" is well done, keep that pattern.

Principle 7. Minor: the page uses em dashes in its own copy ("Your Bitcoin, Emergency Recovery File" and "right here on your device, nothing is sent anywhere") while the rest of the brand voice tends to be cleaner. Standardising punctuation across the product is a small cohesiveness win.

### Priority actions

1. Fix the live state signals on the owner dashboard. Remove or rewrite the developer mainnet banner, correct the "Ready to claim" heir badge so it reflects the true standing by state, fix the "in in" doubled words, and replace raw event codes like "owner_send" and "lightning_invoice_issued" with plain language. These all touch trust and correctness on the screen owners see most.

2. Raise the email confirmation warning to a prominent, clearly explained state. This is the one mechanism standing between the owner and an accidental, irreversible inheritance trigger, so it cannot live as a quiet strip at the bottom of the dashboard.

3. Warm up and layer the heir flow. Add a human opening line to the Inherit entry page, strip the token vocabulary, and split the emergency recovery file into a calm heir layer and a clearly separated expert layer so a grieving non technical person is guided gently rather than dropped into descriptors.

### Privacy first lens

The privacy posture is genuinely strong and worth protecting. "Nothing leaves the browser", "We never hold your keys", and the client side unlock model all point the right way, and the heir contact detail being stored encrypted with no message sent until the trigger is the correct design.

A few points to watch for high risk users. First, the channels offered to reach an heir are email, SMS, and WhatsApp. SMS in particular is the least private and most interceptable of the three, and in some countries it is monitored. We could add a short, plain note that more private channels exist and that SMS is the least private option, so a careful user can choose well. Second, the trust tip that tells the owner to warn the heir in advance is excellent anti scam practice and also a privacy consideration, since an out of band heads up reduces the chance the heir dismisses the real message or that an attacker imitates it. Third, the recovery file advises checking funds via a public block explorer; for a privacy conscious user, searching their own address on a third party explorer leaks that address to that service. A one line note offering the self hosted or watch only path for the cautious would respect that user.

Nothing in the copy made the user feel surveilled by GhostKey itself, which is good. The language is mostly empowering rather than dependence creating, with the honest "nothing on this site for you to do" and "still your Bitcoin" lines reinforcing user control. An activist in a high risk country would likely feel reasonably safe with the owner side; the main exposure is the heir contact channel choice, which the SMS note above would address.

### Non-native English speaker lens

Read as someone who learned English formally and is reading quickly under stress, these are the words and phrases to simplify.

"Real money is in scope" (mainnet banner). "in scope" is workplace jargon. Replace the whole banner with plain confidence, for example "Your funds are real Bitcoin on the live network."

"NON-CUSTODIAL" and "On-chain GUARANTEED" (hero stats). Both are insider terms. Replace with "We never hold your keys" and "No company can freeze it".

"no terminal commands" (how it works). Names a technical thing the reader does not know. Replace with "nothing technical to install".

"the channel you pick" (heir step). "channel" reads as a tech word. Replace with "the way you choose to reach them".

"Slack if you miss one" and "Extra slack" (timing). "slack" meaning spare time is idiomatic and collides with the app named Slack. Replace with "Extra time" or "Grace period".

"the alarm fires" (heir email note). Idiom. Replace with "if you stop checking in".

"A quiet heads-up now" (trust tip). "heads-up" is idiomatic. Replace with "A quiet word now".

"enters its alarm state" (grace period). Tech metaphor. Replace with "before the countdown to inheritance begins".

"We unwrap your keys in this tab" (sign in). "unwrap your keys" is jargon. Replace with "We unlock your vault right here on your device".

"owner_send", "lightning_invoice_issued" (activity feed). Not English at all to a normal reader. Replace with "You sent Bitcoin", "Reminder check in paid".

"one-time access token" and "The bit after /claim/" (inherit). "token" is jargon and "the bit after" is casual and unclear. Replace with "Your link is private and works only once."

"Read the docs" (footer call to action). "docs" is developer shorthand. Replace with "How it works" or "Learn more".

"programmable self-custody continuity for Bitcoin" (footer). The single hardest phrase in the product for any reader. Replace with "a way to make sure your family can reach your Bitcoin if you are gone".

On sentence length, most of the product keeps sentences short and calm, which translates well. The exceptions are the recovery file paragraphs about descriptors and Bitcoin Core, which pack several clauses and several unknown nouns into one sentence. Splitting those into short lines and moving them into the clearly marked expert section will help every reader, not only non native ones.

### What is working well

The voice is the headline strength. "Set up once. Tap once a month to say you're here", "That's the whole job", "Your people get what you left them", and "Your spare key" are some of the clearest, kindest copy in the Bitcoin space. Hold onto whoever writes like this.

The mental model is honest and consistent: a heartbeat that keeps your Bitcoin alive, a clear lifecycle from created to passed on, and a constant reminder that the owner stays in control until the heir claims. The "Nothing happens today" and "Always in control" reassurances land at exactly the right moments and answer the user's real anxiety.

The progressive disclosure of advanced features is handled well. The xpub path is hidden behind an explicit advanced link, the "they have no wallet" case is handled for the heir, and the technical Bitcoin claims are available for the readers who want to verify them. The recovery story, both the spare key and the emergency file, shows real thought about what happens if GhostKey itself disappears, which is exactly the integrity an inheritance product needs. The privacy promises are concrete and plainly stated rather than vague.

The bones are very good. Almost everything above is about closing the gap between this strong foundation and the few live, high stakes moments where the polish has not yet caught up.
