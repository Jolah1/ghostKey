use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid timelock: {0} (must be 1..=65535 blocks for CSV)")]
    InvalidTimelock(u32),

    #[error("invalid unlock height: {0} (must be 1..500000000 for an absolute block-height CLTV)")]
    InvalidUnlockHeight(u32),

    #[error("invalid descriptor: {0}")]
    InvalidDescriptor(String),

    #[error("miniscript error: {0}")]
    Miniscript(#[from] miniscript::Error),

    #[error("bitcoin parse error: {0}")]
    BitcoinParse(String),

    #[error("bip32 error: {0}")]
    Bip32(#[from] bitcoin::bip32::Error),

    #[error("secp256k1 error: {0}")]
    Secp256k1(#[from] bitcoin::secp256k1::Error),

    #[error("psbt error: {0}")]
    Psbt(String),

    #[error("invalid xpub: {0}")]
    InvalidXpub(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("bip39 error: {0}")]
    Bip39(String),

    #[error("hkdf error: {0}")]
    Hkdf(String),
}
