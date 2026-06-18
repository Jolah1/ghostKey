Title: UX: Owner dashboard and heir flow, close the trust and clarity gaps at the highest stakes moments

## Summary

GhostKey already has a strong, warm voice and an honest mental model. This issue is about closing the gap between that strong foundation and the few live, high stakes moments where the polish has not yet caught up: the owner dashboard, where a couple of signals currently say the wrong thing, and the heir flow, where our most vulnerable user meets our coldest screens. These are mostly copy and state fixes, not redesigns, and each one raises user confidence at a moment that matters.

## Review framework

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

## Findings ordered by screen

### Global banner
Principle 2, Principle 7. The banner "Mainnet: GhostKey is running on Bitcoin mainnet. Real money is in scope. Confirm your security review is complete." reads as an internal staging message that reached production. "Real money is in scope" and "Confirm your security review is complete" are engineering phrases that tell an owner the app is not finished and not safe, on the first screen they see.

### Owner dashboard
Principle 2, Principle 7. The heir chip shows a green "Ready to claim" badge while the owner is alive and has just checked in. This implies the heir can take the funds right now, which is false and frightening on an inheritance product. This is the single most important correctness fix.

Principle 1, Principle 10. "Confirm your email so reminders reach you" sits as a quiet strip near the bottom. If reminders never arrive because the email was never confirmed, the owner can miss check ins and trigger inheritance by accident. For the one mechanism that prevents a permanent mistake, this is far too quiet.

Principle 4. The recent activity feed shows raw event codes: "owner_send" and "lightning_invoice_issued". These are database labels, not language a person understands.

Principle 7. Two doubled words, "Next reminder in in 4 days" and "The next one opens in in 1 day". On a money product these small slips lower trust.

Principle 7. The primary heartbeat button is a disabled "Locked until next period" with "in 4 days before countdown begins" beneath it. The hero action being a dead button confuses a returning user, and "before countdown begins" mixes calm with anxiety. The heir name is also truncated to "F..." which looks broken.

### Heir inherit entry
Principle 3. This is the heir's first run and a crisis point at least as serious as owner onboarding, because the heir may be grieving and new to Bitcoin. The page is honest but cold, with no acknowledgement of the human moment.

Principle 4. "one-time access token", "The bit after /claim/", and the raw URL example are developer framing on the screen meant for the least technical user in the product.

### Emergency recovery file
Principle 4, Principle 6. The top half is excellent plain education. The bottom half is the most jargon dense screen in the product: block explorer, descriptor, Bitcoin Core version 26, timelock, Sparrow, Liana, plus two raw descriptor strings. This is the correct fallback for a technical helper, but a non technical heir who lands here directly may panic.

## Suggested changes

### Global banner
We could remove this for end users, or replace it with one calm line of confidence, for example "You are on the live Bitcoin network. Your funds are real." Keep the warning out of the owner and heir flows entirely.

### Owner dashboard
We could change the heir state label to reflect reality, for example "Standing by", "Set up", or "Will be notified if you stop checking in", and reserve "Ready to claim", and the colour green, strictly for the genuinely claimable state. We could raise the email confirmation to a prominent banner that stays until confirmed, with the stakes in plain words: "Until you confirm your email, we cannot remind you to check in." We could map every activity event to plain language, for example "You sent Bitcoin" and "Reminder check in paid". We could fix the "in in" doubled words. We could replace the dead locked button with a calm resting state such as "You are all set. Next check in opens in 4 days", and show the full heir name rather than a truncated initial.

### Heir inherit entry
We could open with one warm, plain line before the mechanics, for example "If you are here, someone trusted you to look after something they left behind. We will walk you through it slowly." We could drop the token vocabulary and the raw URL, keeping only the reassurance: "Your link is private and works only once. Please do not share it." Consider breaking the flow into a few gentle steps rather than one screen, so a grieving person is never asked to take in everything at once.

### Emergency recovery file
We could split the page into two clear layers: a calm top layer for the heir ("Type your password and press Unlock, that is all you need") and a clearly separated, collapsed lower layer headed "For a Bitcoin expert helping you" that holds the descriptors and the Bitcoin Core instructions. Keep the strong existing education, the "unlocks on your device, nothing is sent anywhere" line and the "slow on purpose" explanation, and keep translating values like "4,320 blocks" to "about 30 days".

### Non native English wording, quick wins across screens
Replace "the channel you pick" with "the way you reach them". Replace "Slack if you miss one" and "Extra slack" with "Extra time". Replace "the alarm fires" and "enters its alarm state" with "if you stop checking in". Replace "We unwrap your keys in this tab" with "We unlock your vault right here on your device". Replace "Read the docs" with "How it works". Replace the footer "programmable self-custody continuity for Bitcoin" with "a way to make sure your family can reach your Bitcoin if you are gone".

### Privacy note for high risk users
The heir contact options are email, SMS, and WhatsApp. SMS is the least private and is monitored in some countries. We could add a short plain note that SMS is the least private option so a careful user can choose well.

## Reference

Wallet of Satoshi for radical simplicity on the dashboard, and Muun for the gentle, explain then ask onboarding rhythm that suits the heir flow. The heir flow exploration in this review used Muun's light, one idea per screen approach, which maps onto GhostKey's existing light theme rather than replacing the brand.
