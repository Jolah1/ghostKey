/**
 * i18n shell — string tables and shared shape (#204).
 *
 * One `Vocab` object per language (see `en.ts`, `pcm.ts`). Only
 * translatable copy lives here; the brand name is a constant and the
 * status *tone* is semantic (not language-specific), so both are shared
 * rather than duplicated per language.
 *
 * Tone rules carry over from the old vocab module: direct, emotional,
 * plain. No "savings", no "vault" in body copy, no AI tells.
 */
import type { VaultStatus } from "../api";

export type Lang = "en" | "pcm";

/** The brand name is never translated. */
export const brandName = "GhostKey";

export type Tone = "ok" | "warning" | "alarm" | "neutral";

export interface StatusCopy {
  label: string;
  long: string;
  tone: Tone;
}

/**
 * Status tone is semantic, not language-specific, so it's defined once
 * and composed with each language's text by {@link makeStatus}.
 */
export const STATUS_TONE: Record<VaultStatus, Tone> = {
  unfunded: "neutral",
  ok: "ok",
  warning: "warning",
  alarmed: "alarm",
  timelock_started: "alarm",
  claiming: "alarm",
  claimed: "neutral",
  frozen: "alarm",
};

/** Per-status label + long text, supplied by each language. */
export type StatusText = Record<VaultStatus, { label: string; long: string }>;

/** Compose a language's status text with the shared tone map. */
export function makeStatus(text: StatusText): (s: VaultStatus) => StatusCopy {
  return (s) => ({ ...text[s], tone: STATUS_TONE[s] });
}

/** A simple informational screen: small eyebrow, headline, body. */
export interface Screen {
  eyebrow: string;
  title: string;
  body: string;
}

/**
 * Heir-facing claim page copy. This is the highest-stakes plain-language
 * surface, so it's the first screen migrated into the language layer.
 * Only the informational states are here; the interactive claim
 * mechanics (PSBT/broadcast) are a later slice.
 *
 * Where a sentence wraps an emphasised value (a date, a countdown), the
 * string is split into `…Before`/`…After` halves rendered around the
 * value in JSX. EN and PCM share word order, so the split is safe.
 */
export interface ClaimVocab {
  /** Top-right header note ("A message for you"). */
  header: string;
  loading: string;
  notFound: Screen;
  alreadyUsed: Screen;
  timelockWait: {
    eyebrow: string;
    title: string;
    etaBefore: string;
    etaAfter: string;
    noEta: string;
    note: string;
  };
  safetyWait: {
    eyebrow: string;
    title: string;
    body1: string;
    body2Before: string;
    body2After: string;
    note: string;
  };
  notReady: {
    eyebrow: string;
    title: string;
    body: string;
    nextCheckin: (friendly: string) => string;
  };
  alreadyClaimed: {
    eyebrow: string;
    title: string;
    body: (label: string | null) => string;
  };
  /** Reload-safe receipt once the claim broadcast succeeded: the heir's
   *  link keeps showing the txid instead of "already used". */
  claimedSuccess: {
    eyebrow: string;
    title: string;
    body: string;
    txidLabel: string;
    explorer: string;
    homeCta: string;
  };
  error: {
    eyebrow: string;
    tryAgain: string;
  };
  checking: {
    eyebrow: string;
    title: string;
    body: string;
    firstLoadSlow: string;
    firstLoadEstimating: string;
  };
  probeError: {
    holdOn: string;
  };
  technical: {
    showDetails: string;
  };
  footer: string;
}

export interface DrillVocab {
  bannerTitle: string;
  bannerBody: string;
  introEyebrow: string;
  introTitle: (name: string | null) => string;
  introBody1: string;
  introBody2: string;
  introCta: string;
  walkthroughEyebrow: string;
  walkthroughTitle: string;
  walkthroughStep1Title: string;
  walkthroughStep1Body: string;
  walkthroughStep2Title: string;
  walkthroughStep2Body: string;
  walkthroughStep3Title: string;
  walkthroughStep3Body: string;
  walkthroughFinishing: string;
  walkthroughFinish: string;
  doneEyebrow: string;
  doneTitle: string;
  doneBody: string;
  doneClose: string;
}

export interface ClaimCommonVocab {
  whatIsBeingPassedOn: string;
  defaultLabel: string;
  step1: string;
  step2: string;
  step3: string;
  whereShouldMoneyGo: string;
  bitcoinAddress: string;
  reviewAndSend: string;
  sendingBitcoin: string;
  sendTheBitcoin: string;
  everythingMinusFee: string;
  defaultFeeLabel: string;
  someonesLeftYou: string;
  pageDescription: string;
  advancedFee: string;
  feeRateLabel: string;
  feeRateInvalid: string;
  feeRateHint: string;
  feeRateHintDetailed: string;
  addressInvalidShape: string;
  doYouHaveWallet: string;
  walletDesc: (network: string, examples: string) => string;
  haveWalletYes: string;
  haveWalletYesSub: string;
  haveWalletNo: string;
  haveWalletNoSub: string;
  onNetwork: (network: string) => string;
  addressInstructions1: string;
  addressInstructions2: string;
  addressInstructions3: string;
  addressWrongNetwork: (prefix: string) => string;
  /** Shown when the paste is a Lightning address/invoice/LNURL — tells
   *  the heir how to get their wallet's on-chain address instead. */
  addressLightning: (prefix: string) => string;
  addressPlaceholder: (prefix: string) => string;
  confirmDescription: string;
}

export interface GuardianVocab {
  sentEyebrow: string;
  sentTitle: string;
  eyebrow: string;
  greeting: (heir: string, isHeir: boolean) => string;
  heirBody: (heir: string) => string;
  guardianBody: (heir: string) => string;
  bringLink: (needLabel: string) => string;
  heirLinkInstructions: string;
  guardianLinkInstructions: string;
  bothLinksReady: string;
  pasteLink: (needLabel: string) => string;
  linkHint: string;
  checking: string;
  addLink: string;
  confirmDescription: string;
  errInvalidLink: string;
  errSameLink: string;
  errDifferentVault: string;
  errWrongRoleHeir: string;
  errWrongRoleGuardian: string;
  errAlreadyUsed: string;
  errCheckFailed: string;
}

export interface DerivedClaimVocab {
  confirmEmail: (email: string) => string;
  stopAndContact: string;
  whereShouldMoneyGo: (network: string, examples: string) => string;
  reviewAndClaim: string;
  claimingAndSending: string;
  claimAndSend: string;
  advancedFee: string;
  feePlaceholder: string;
  yourBackupPhrase: string;
  backupDescription: string;
}

export interface ManualClaimVocab {
  walletDesc: (network: string) => string;
  walletWarning: string;
  bitcoinAddress: string;
  whereShouldBitcoinGo: string;
  prepareTransaction: string;
  preparingTransaction: string;
  signInWallet: string;
  signInstructions: string;
  unsignedTransaction: string;
  unsignedDescription: string;
  copy: string;
  copied: string;
  signHint: string;
  signedTransaction: string;
  signedHint: string;
  broadcastTransaction: string;
  broadcasting: string;
  walletGuidePickAny: string;
  walletPsbtDescription: string;
  downloadBitcoinCore: string;
  walletPsbtHint: string;
  psbtSummary: string;
  amountBeingMoved: string;
  youllReceive: string;
  networkFee: string;
  networkLabel: string;
  psbtWarning: string;
}

export interface BroadcastSuccessVocab {
  done: string;
  itsOnTheNetwork: string;
  description: string;
  transactionId: string;
  watchItArrive: string;
  noNeedToKeepOpen: string;
  /** The claim link now resolves to a receipt after success (#280). */
  linkShowsReceipt: string;
  learnMore: string;
}

export interface HeirRecoveryFileVocab {
  advanced: string;
  description: string;
  createFile: string;
  preparing: string;
  couldNotBuild: (message: string) => string;
  tryAgain: string;
  yourCode: string;
  codeDescription: string;
  downloadFile: string;
}

export interface ClaimErrorsCopyEntry {
  headline: string;
  body: string;
  nextStep: string;
}

export interface ClaimErrorsCopy {
  destinationMismatch: ClaimErrorsCopyEntry;
  noUtxos: ClaimErrorsCopyEntry;
  psbtNotFullySigned: ClaimErrorsCopyEntry;
  timelockNotMatured: ClaimErrorsCopyEntry;
  esploraDown: ClaimErrorsCopyEntry;
  olderFormat: ClaimErrorsCopyEntry;
  serverError: ClaimErrorsCopyEntry;
  linkIncomplete: ClaimErrorsCopyEntry;
  genericResolve: ClaimErrorsCopyEntry;
  genericProbe: ClaimErrorsCopyEntry;
  genericSend: ClaimErrorsCopyEntry;
  genericBuild: ClaimErrorsCopyEntry;
  genericBroadcast: ClaimErrorsCopyEntry;
}

export interface InheritPortalVocab {
  eyebrow: string;
  title: string;
  description: string;
  whatLinkLooksLike: string;
  linkExample: string;
  linkPrivacyNote: string;
  alreadyHaveLink: string;
  linkHint: string;
  linkPlaceholder: string;
  openIt: string;
  noLinkYet: string;
}

export interface PracticeCardVocab {
  title: string;
  realClaimLooksSame: string;
  sendAgain: string;
  sendPractice: string;
  cancel: string;
  sending: string;
  errorRealClaimUnderway: string;
  errorSendingFailed: string;
  lineCompleted: (who: string, when: string | null) => string;
  lineOpened: (who: string, when: string | null) => string;
  lineSent: (who: string, when: string | null) => string;
  lineIdle: (who: string, noun: string) => string;
  confirmAlert: (alert: string) => string;
  sentNotified: (who: string) => string;
  sentNotNotified: (who: string) => string;
  practiceNounEmail: string;
  practiceNounSms: string;
  practiceNounWhatsapp: string;
  practiceNounDefault: string;
  sendWordsEmailAlert: (who: string) => string;
  sendWordsEmailButton: (who: string) => string;
  sendWordsSmsAlert: (who: string) => string;
  sendWordsSmsButton: (who: string) => string;
  sendWordsWhatsappAlert: (who: string) => string;
  sendWordsWhatsappButton: (who: string) => string;
  sendWordsDefaultAlert: (who: string) => string;
  sendWordsDefaultButton: (who: string) => string;
}

export interface Vocab {
  /** Human name of this language, for the toggle (e.g. "English"). */
  langName: string;
  tagline: string;
  longTagline: string;
  status: (s: VaultStatus) => StatusCopy;
  claim: ClaimVocab;
  drill: DrillVocab;
  claimCommon: ClaimCommonVocab;
  guardian: GuardianVocab;
  derivedClaim: DerivedClaimVocab;
  manualClaim: ManualClaimVocab;
  broadcastSuccess: BroadcastSuccessVocab;
  heirRecoveryFile: HeirRecoveryFileVocab;
  claimErrors: ClaimErrorsCopy;
  inheritPortal: InheritPortalVocab;
  practiceCard: PracticeCardVocab;
}
