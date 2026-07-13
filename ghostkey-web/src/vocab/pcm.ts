/**
 * Nigerian Pidgin (PCM) — FIRST DRAFT, NOT YET REVIEWED.
 *
 * ⚠️  These strings were drafted by a non-native writer and MUST be
 * reviewed for tone and accuracy by a Pidgin speaker before this is
 * considered done (see #204 — human review is the gating step). Treat
 * every line here as a placeholder to correct, not a final translation.
 * Keep the same keys as `en.ts`; only the wording changes.
 */
import { makeStatus, type Vocab } from "./types";

export const pcm: Vocab = {
  langName: "Pidgin",
  tagline: "Make your Bitcoin reach your people, no lawyer wahala.",
  longTagline:
    "Set am once. Every month, tap to show say you dey. If you ever stop, the people wey you choose fit collect wetin be their own.",
  status: makeStatus({
    unfunded: {
      label: "Dey wait for money",
      long: "Send Bitcoin go your vault make e start. Check-in go begin once money enter.",
    },
    ok: {
      label: "E dey work",
      long: "Everything dey alright.",
    },
    warning: {
      label: "Tap soon",
      long: "Reminder dey come. Tap when you fit.",
    },
    alarmed: {
      label: "You miss reminder",
      long: "Tap now make the clock reset. Nothing never lost.",
    },
    timelock_started: {
      label: "We don send claim",
      long: "We don send the claim link give your heir.",
    },
    claiming: {
      label: "Dem dey claim",
      long: "Your heir dey broadcast the claim transaction.",
    },
    claimed: {
      label: "Don pass to dem",
      long: "Dem don claim this vault.",
    },
    frozen: {
      label: "Panic stop",
      long: "You trigger panic. The vault go freeze for 90 days.",
    },
  }),
  claim: {
    header: "Message for you",
    loading: "We dey open your link…",
    notFound: {
      eyebrow: "This link no dey work",
      title: "We no fit find anything for this link",
      body: "The link fit no complete, don expire, or dem copy am wrong. If person send you am for SMS or WhatsApp, tell dem make dem send am again from start.",
    },
    alreadyUsed: {
      eyebrow: "Dem don open this link before",
      title: "E be like say person don reach here before",
      body: "Claim link dey work only once. If you don collect wetin dem leave for you, you don finish. If you never, talk to the person wey set am up. Dem fit send new link.",
    },
    timelockWait: {
      eyebrow: "Your inheritance",
      title: "Your money dey come",
      etaBefore: "Wetin dem leave for you go open for Bitcoin network around ",
      etaAfter:
        ". Nothing dey for you to do. We go email you when e ready, and you fit come back with this same link.",
      noEta:
        "We still dey confirm the money for Bitcoin network. Nothing dey for you to do. Check back small time with this same link.",
      note: "Bitcoin dey hold inheritance for some time before dem fit collect am.",
    },
    safetyWait: {
      eyebrow: "We don near",
      title: "Your claim don start. Small safety wait dey",
      body1:
        "You don do everything well, and dem dey prepare wetin dem leave for you. To protect everybody, every claim get small waiting time before dem fit collect anything.",
      body2Before:
        "We go email you once everything ready, so you no need to remember or dey check. You fit also come back ",
      body2After: " with this same link.",
      note: "Why the wait? E dey give the person wey set am up one last chance to respond if na mistake start this claim. If nothing change, your claim go continue by itself.",
    },
    notReady: {
      eyebrow: "Never yet",
      title: "Time never reach",
      body: "The person wey set am up still dey active. Nothing dey for you to do today. You go get new message if anything change.",
      nextCheckin: (friendly) => `Next check na ${friendly}.`,
    },
    alreadyClaimed: {
      eyebrow: "Done",
      title: "Dem don pass this one already",
      body: (label) =>
        `${
          label ? `Dem don claim "${label}" before.` : "Dem don claim this inheritance before."
        } Nothing dey again to do here.`,
    },
    claimedSuccess: {
      eyebrow: "E don finish",
      title: "The Bitcoin don be your own",
      body: "Dem don claim this inheritance and send am. The money dey inside the wallet wey dem choose when dem claim am. Nothing remain to do here.",
      txidLabel: "Your receipt: the transaction ID",
      explorer: "See am for Bitcoin network",
      homeCta: "Learn more about GhostKey",
    },
    error: {
      eyebrow: "Something dey wrong",
      tryAgain: "Try again",
    },
    checking: {
      eyebrow: "One moment",
      title: "We dey check the Bitcoin network",
      body: "This one dey take time. Leave this page open, or come back with the same link later.",
      firstLoadSlow: "This fit take up to one minute for first time. You fit leave this page open and e go update by itself.",
      firstLoadEstimating: "We dey check when your money go ready…",
    },
    probeError: {
      holdOn: "Hold on",
    },
    technical: {
      showDetails: "Show technical details",
    },
    footer: "This page come from GhostKey, a Bitcoin inheritance service. The link wey you open, dem send am because somebody wey you know set up inheritance and add your phone or email.",
  },
  drill: {
    bannerTitle: "This na practice run",
    bannerBody: "Everybody dey fine, and nothing real dey happen for this page. E dey here so that the real thing no go be the first time you see am.",
    introEyebrow: "A practice run",
    introTitle: (name) =>
      name ? `Hello ${name}, somebody set something aside for you` : "Hello, somebody set something aside for you",
    introBody1: "Dem use GhostKey make sure say if dem ever stop dey around, wetin dem save for Bitcoin go reach you. Dem ask us to show you how e dey work, today, while dem fit answer your questions.",
    introBody2: "E go take about one minute. You no need account and you no fit break anything.",
    introCta: "Show me how e dey work",
    walkthroughEyebrow: "Wetin the real day go be like",
    walkthroughTitle: "Three things go happen",
    walkthroughStep1Title: "1. You go get message like today",
    walkthroughStep1Body: "If dem stop to confirm say dem dey okay, we go send you link, just like the one wey you open. That part you don practice already.",
    walkthroughStep2Title: "2. Small wait dey",
    walkthroughStep2Body: "Bitcoin itself dey enforce waiting period, and this page go show you the date. You just come back when e talk say make you come back. If dem record video message for you, e go play for here for the real day.",
    walkthroughStep3Title: "3. The money go come straight to you",
    walkthroughStep3Body: "You go paste address from any Bitcoin wallet for your phone, and e go arrive there. GhostKey no dey hold the money, so no company fit lose am or keep am from you.",
    walkthroughFinishing: "We dey finish…",
    walkthroughFinish: "Finish the practice",
    doneEyebrow: "Practice don finish",
    doneTitle: "You don finish, and you do am well",
    doneBody: "The person wey set this up go see say the practice work. Nothing move and nothing change. If the real day ever come, e go look exactly like wetin you just do.",
    doneClose: "You fit close this page.",
  },
  claimCommon: {
    whatIsBeingPassedOn: "Wetin dem dey pass on",
    defaultLabel: "A Bitcoin inheritance",
    step1: "Step 1",
    step2: "Step 2",
    step3: "Step 3",
    whereShouldMoneyGo: "Where the money go go?",
    bitcoinAddress: "Your Bitcoin address",
    reviewAndSend: "Check and send",
    sendingBitcoin: "We dey send Bitcoin…",
    sendTheBitcoin: "Send the Bitcoin",
    everythingMinusFee: "Everything for the vault, minus network fee",
    defaultFeeLabel: "2 sat/vB",
    someonesLeftYou: "Somebody leave something for you",
    pageDescription: "Somebody wey you know leave you Bitcoin. Dem set up GhostKey so that if dem ever stop to check in, the link go reach you. Na wetin don happen. This page na for you.",
    advancedFee: "Advanced: change the network fee",
    feeRateLabel: "Fee rate for sat/vB (optional)",
    feeRateInvalid: "Enter whole number between 1 and 1000, or leave am empty.",
    feeRateHint: "Leave empty make e use 2 sat/vB.",
    feeRateHintDetailed: "Leave empty make e use 2 sat/vB. Make e higher if you wan make the transaction confirm faster.",
    addressInvalidShape: "That one no look like Bitcoin address. Check the start.",
    doYouHaveWallet: "You get Bitcoin wallet?",
    walletDesc: (network, examples) =>
      `Bitcoin wallet na app where you fit receive Bitcoin. You only need one wey fit receive on the ${network}. Lightning wallet work too. ${examples} all dey work.`,
    haveWalletYes: "Yes, I get",
    haveWalletYesSub: "Skip go step 2",
    haveWalletNo: "No, I never get",
    haveWalletNoSub: "We go show you somewhere",
    onNetwork: (network) => `For the ${network}.`,
    addressInstructions1: "Open any Bitcoin wallet and tap ",
    addressInstructions2: " to get address. Copy the long address wey start with ",
    addressInstructions3: " and paste am below.",
    addressWrongNetwork: (prefix) =>
      `That address na for different network. E suppose start with ${prefix}.`,
    addressLightning: (prefix) =>
      `That one be like Lightning address or invoice. This money dey move for the Bitcoin network itself, so e need Bitcoin address. For your wallet, tap Receive and choose Bitcoin or On-chain, then paste the address wey start with ${prefix}.`,
    addressPlaceholder: (prefix) => `${prefix}...`,
    confirmDescription: "We go show you the details to check, then prepare and broadcast the transaction for you. You no need to sign anything for another app.",
  },
  guardian: {
    sentEyebrow: "E don do",
    sentTitle: "Don send.",
    eyebrow: "Two of una, together",
    greeting: (heir, isHeir) => isHeir ? `Hello ${heir}.` : `Dey help ${heir}.`,
    heirBody: (heir) =>
      `Somebody set this up so that ${heir} and a trusted guardian finish am together. You no fit do am alone, and na on purpose. Ask one guardian make e dey with you now.`,
    guardianBody: (heir) =>
      `${heir} don set up with guardian help. You be one of the guardians. To finish, ${heir} and you go do am together for this page.`,
    bringLink: (needLabel) => `Bring ${needLabel} link`,
    heirLinkInstructions: "Every guardian get their own message with link. Ask one guardian make dem open their link and paste am below, or paste am for dem.",
    guardianLinkInstructions: "The heir get their own message with link. Paste am below make the two halves come together.",
    bothLinksReady: "Both links dey here. You fit finish below.",
    pasteLink: (needLabel) => `Paste ${needLabel} link`,
    linkHint: "Na the long web link from their message.",
    checking: "We dey check…",
    addLink: "Add this link",
    confirmDescription: "We go show you the details to check, then prepare and broadcast the transaction for both of una. No app to install.",
    errInvalidLink: "That one no look like GhostKey link. Paste the whole link.",
    errSameLink: "Na the link wey you don open. Paste the other person link.",
    errDifferentVault: "That link na for different inheritance. Check say you get the correct one.",
    errWrongRoleHeir: "Na another heir link. You need guardian link to finish.",
    errWrongRoleGuardian: "Na guardian link. You need the heir link to finish.",
    errAlreadyUsed: "Dem don use that link before.",
    errCheckFailed: "We no fit check that link. Try again later.",
  },
  derivedClaim: {
    confirmEmail: (email) => `Dem tell us to expect ${email}.`,
    stopAndContact: "If that one no be your email, stop and reach out to the person wey send you this link.",
    whereShouldMoneyGo: (network, examples) =>
      `Paste any Bitcoin address wey you control for the ${network}. Lightning wallet work too. Apps like Blink, Bitnob, or Wallet of Satoshi each go give you Bitcoin address wey go add the money to your balance. ${examples}.`,
    reviewAndClaim: "Check and claim",
    claimingAndSending: "We dey send Bitcoin…",
    claimAndSend: "Claim and send",
    advancedFee: "Advanced: custom fee rate",
    feePlaceholder: "sat/vB (optional, like 4)",
    yourBackupPhrase: "Your backup phrase",
    backupDescription: "Write these 12 words down for somewhere safe. Na the only way to recover this key without GhostKey. The funds wey you just claim don dey go your address. This na just insurance.",
  },
  manualClaim: {
    walletDesc: (network) =>
      `Bitcoin wallet na app where you fit receive and hold Bitcoin for the ${network}. This claim special: e need wallet wey fit sign Bitcoin Taproot timelock. Most phone wallets no fit. The one wey we test na Bitcoin Core, for computer.`,
    walletWarning: "One thing to check first: most phone wallets no fit sign this kind claim. If your wallet no fit sign Bitcoin Taproot script, choose No, not yet and we go show you Bitcoin Core.",
    bitcoinAddress: "Your Bitcoin address",
    whereShouldBitcoinGo: "Where the Bitcoin go go?",
    prepareTransaction: "Prepare transaction",
    preparingTransaction: "We dey prepare transaction…",
    signInWallet: "Sign am for your wallet",
    signInstructions: "We don prepare unsigned transaction. GhostKey no fit sign am for you. This claim dey spend Bitcoin timelock, so e need wallet wey fit sign Taproot scripts. Many phone wallets no fit. Bitcoin Core na the one wey we test. If the wallet wey hold your key fit open and sign this, that one work too. Sign am there, then paste the signed transaction back.",
    unsignedTransaction: "Unsigned transaction",
    unsignedDescription: "This long block of letters and numbers na just your transaction wey dem write as text (dem dey call am \"PSBT\"). Nothing here fit spend your money by itself. E still need to sign. E safe to copy.",
    copy: "Copy",
    copied: "Don copy",
    signHint: "Open the wallet wey hold your key, find the transaction signer (dem sometimes call am \"sign PSBT\"), paste this one inside, and sign.",
    signedTransaction: "Signed transaction",
    signedHint: "Paste back wetin your wallet give you after signing.",
    broadcastTransaction: "Broadcast transaction",
    broadcasting: "We dey broadcast…",
    walletGuidePickAny: "Pick any of these. Download am for your phone, open am, and follow the steps inside.",
    walletPsbtDescription: "To sign this claim, you need wallet wey fit sign Bitcoin Taproot timelock scripts. Most phone wallets no fit. The one wey we test na Bitcoin Core, for desktop computer.",
    downloadBitcoinCore: "Download Bitcoin Core",
    walletPsbtHint: "Open the transaction below for Bitcoin Core, sign am, and paste the signed version back here.",
    psbtSummary: "Transaction summary",
    amountBeingMoved: "Amount we dey move",
    youllReceive: "You go receive",
    networkFee: "Network fee",
    networkLabel: "Network",
    psbtWarning: "Double-check these numbers for your wallet before you sign. If the amount or destination no look correct, no sign. Come back and start again.",
  },
  broadcastSuccess: {
    done: "E don do",
    itsOnTheNetwork: "E dey for the network",
    description: "Dem don broadcast your transaction. Bitcoin transaction dey confirm within one hour, sometimes faster. Once e confirm, the funds na your own.",
    transactionId: "Transaction ID",
    watchItArrive: "Watch am arrive \u2197",
    noNeedToKeepOpen: "You no need to keep this page open. The transaction dey for the Bitcoin network and e go confirm by itself.",
    linkShowsReceipt: "If you come back to your claim link later, e go show you this receipt again.",
    learnMore: "Learn more about GhostKey",
  },
  heirRecoveryFile: {
    advanced: "Advanced: save your own recovery file",
    description: "This go download file wey fit reach this Bitcoin without GhostKey, using just code wey we go show you. You no need am to receive the money wey dey above. Na backup, and one way to do am yourself if you ever want.",
    createFile: "Create my recovery file",
    preparing: "We dey prepare your file… this one go take small time.",
    couldNotBuild: (message) => `We no fit build the file: ${message}`,
    tryAgain: "Try again",
    yourCode: "Your code, write am down",
    codeDescription: "The file dey locked with this code. We no go show am again, and we no dey store am. Keep the file and the code together.",
    downloadFile: "Download the file",
  },
  claimErrors: {
    destinationMismatch: {
      headline: "That address no fit",
      body: "The address wey you paste no match the network wey this Bitcoin dey. Dem dey look similar but start with different letters.",
      nextStep: "Open your wallet, make sure e dey for the right network, and copy fresh address.",
    },
    noUtxos: {
      headline: "Nothing dey to claim yet",
      body: "The vault empty right now. Either dem never fund am, or somebody don move the Bitcoin out.",
      nextStep: "Contact the person wey set this up. Dem fit tell you whether to wait or whether nothing ever dey inside.",
    },
    psbtNotFullySigned: {
      headline: "Your signature no complete",
      body: "The pre-signed transaction come back without all the signatures wey e need.",
      nextStep: "Open the transaction for your wallet again, finish signing, and paste the new result back here.",
    },
    timelockNotMatured: {
      headline: "The waiting period no finish",
      body: "Bitcoin dey enforce delay between when the alarm fire and when dem fit move the funds. The clock dey run for the chain, no for this server.",
      nextStep: "Come back to this page for a few hours. Your link still dey valid.",
    },
    esploraDown: {
      headline: "We no fit reach the Bitcoin network right now",
      body: "Our connection to the public Bitcoin index don down. This na temporary outage for our side.",
      nextStep: "Try again for a few minutes. Your link still dey valid.",
    },
    olderFormat: {
      headline: "This link dey use older format",
      body: "The way dem set this vault up dey supported, but our automatic detection confuse.",
      nextStep: "Contact the person wey set this up so we fit help finish the claim by hand.",
    },
    serverError: {
      headline: "Something dey wrong for our side",
      body: "This no be something wey you fit fix from your side, and your link still dey valid.",
      nextStep: "Try again for a few minutes. If e keep dey happen, contact the person wey set this up.",
    },
    linkIncomplete: {
      headline: "Your link look like e no complete",
      body: "Part of this link dey carry the key wey dem need to unlock the inheritance. The link wey we receive no whole, usually because e cut when dem share am.",
      nextStep: "Ask the person wey send am make dem share the full link again.",
    },
    genericResolve: {
      headline: "We no fit open your link",
      body: "Something dey wrong when we dey load the page. This no be anything wey you do.",
      nextStep: "Try again later. If e keep dey happen, ask the sender make dem share the link again.",
    },
    genericProbe: {
      headline: "We hit small problem when dey open your link",
      body: "We no fit read the details for this inheritance.",
      nextStep: "Try again later. If e keep dey happen, contact the person wey set this up.",
    },
    genericSend: {
      headline: "We no fit complete the transfer",
      body: "Something dey wrong when dey send the Bitcoin. The transfer no go through, and your link still dey valid.",
      nextStep: "Try again for a few minutes. If e keep dey happen, contact the person wey set this up.",
    },
    genericBuild: {
      headline: "We no fit prepare the transaction",
      body: "Something dey wrong when dey put the transaction together. Your link still dey valid.",
      nextStep: "Try again for a few minutes. If e keep dey happen, contact the person wey set this up.",
    },
    genericBroadcast: {
      headline: "We no fit send the transaction",
      body: "Something dey wrong when dey publish the signed transaction. Your link still dey valid and the funds never move.",
      nextStep: "Open the transaction for your wallet again, sign am clean, and paste the result back here.",
    },
  },
  inheritPortal: {
    eyebrow: "Inherit",
    title: "Somebody trust you with this",
    description: "If you dey here, somebody wey you know leave something behind and trust you to look after am. We go walk you through am slowly, one step at a time. If you no get your link yet, that one normal. E go arrive by SMS, WhatsApp, or email when the time come. No account to sign in to.",
    whatLinkLooksLike: "Wetin the link go be like",
    linkExample: "https://www.ghostkeyapp.com/#/claim/AbCdEf12_3456_etc…",
    linkPrivacyNote: "Your link na private and e dey work only once. No share am with anybody.",
    alreadyHaveLink: "You don get your link?",
    linkHint: "Paste the whole link, or just the code wey dey for the end.",
    linkPlaceholder: "https://www.ghostkeyapp.com/#/claim/…",
    openIt: "Open am",
    noLinkYet: "You no get link yet? That one normal. You go only receive one if the person wey set up the vault stop to check in. Until then, nothing dey for this site for you to do.",
  },
  practiceCard: {
    title: "Practice claim",
    realClaimLooksSame: "The real claim go look exactly like wetin dem practice.",
    sendAgain: "Send again",
    sendPractice: "Send a practice",
    cancel: "Cancel",
    sending: "We dey send…",
    errorRealClaimUnderway: "Real claim don start for this vault, so practice no fit happen.",
    errorSendingFailed: "Sending no work. Your vault fine. Try again later.",
    lineCompleted: (who, when) =>
      when ? `${who} don complete practice claim for ${when}.` : `${who} don complete practice claim.`,
    lineOpened: (who, when) =>
      when
        ? `${who} open the practice link for ${when} but never finish am.`
        : `${who} open the practice link but never finish am.`,
    lineSent: (who, when) =>
      when
        ? `Practice don send for ${when}. ${who} never open am yet.`
        : `Practice don send. ${who} never open am yet.`,
    lineIdle: (who, noun) =>
      `See the claim work while you dey here to help. ${who} go get clearly-marked ${noun} and walk the real steps. Nothing fit move.`,
    confirmAlert: (alert) => `${alert} The message talk say you fine and say this na practice.`,
    sentNotified: (who) => `E dey on the way. You go see am here when ${who} open the link and when dem finish.`,
    sentNotNotified: (who) => `We no fit reach ${who} by ourselves. Share this practice link with dem yourself:`,
    practiceNounEmail: "practice email",
    practiceNounSms: "practice text message",
    practiceNounWhatsapp: "practice WhatsApp message",
    practiceNounDefault: "practice message",
    sendWordsEmailAlert: (who) => `This one go email ${who} right now.`,
    sendWordsEmailButton: (who) => `Email ${who} now`,
    sendWordsSmsAlert: (who) => `This one go text ${who} right now.`,
    sendWordsSmsButton: (who) => `Text ${who} now`,
    sendWordsWhatsappAlert: (who) => `This one go send ${who} WhatsApp message right now.`,
    sendWordsWhatsappButton: (who) => `Message ${who} for WhatsApp`,
    sendWordsDefaultAlert: (who) => `This one go send ${who} message right now.`,
    sendWordsDefaultButton: (who) => `Send am give ${who} now`,
  },
};
