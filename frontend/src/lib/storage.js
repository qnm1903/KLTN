import localforage from 'localforage';

// ============================================================================
// PHẦN 1: LOGIC LOCAL TEST & LƯU TRỮ KEY 
// ============================================================================
/*
 * Legacy local test mode (giữ lại để tham chiếu logic cũ):
 *
 * const IS_LOCAL_TEST_MODE = true;
 * export const getStorageKey = (key) => {
 *   if (!IS_LOCAL_TEST_MODE) return key;
 *   const urlParams = new URLSearchParams(window.location.search);
 *   const role = urlParams.get('role') || 'default';
 *   return `${role}_${key}`;
 * };
 */

const DEFAULT_STORAGE_SCOPE = 'anonymous';

function normalizeWalletAddress(walletAddress) {
  return String(walletAddress || '').trim().toLowerCase();
}

function resolveStorageScope(walletAddress) {
  const normalizedWalletAddress = normalizeWalletAddress(walletAddress);
  return normalizedWalletAddress || DEFAULT_STORAGE_SCOPE;
}

function readLegacyRoleScopedLocalStorageItem(key) {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  const urlParams = new URLSearchParams(window.location.search);
  const role = urlParams.get('role') || 'default';
  return window.localStorage.getItem(`${role}_${key}`);
}

function getLegacyRoleScopedSessionKey(escrowId) {
  const urlParams = new URLSearchParams(window.location.search);
  const role = urlParams.get('role') || 'default';
  return `${role}_session_${escrowId}`;
}

function migrateLegacyRoleScopedLocalStorageItem(key, walletAddress) {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  const scopedKey = getStorageKey(key, walletAddress);
  const existingScopedValue = window.localStorage.getItem(scopedKey);
  if (existingScopedValue) return existingScopedValue;

  const legacyValue = readLegacyRoleScopedLocalStorageItem(key);
  if (!legacyValue) return null;

  window.localStorage.setItem(scopedKey, legacyValue);
  return legacyValue;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENCRYPTED_PRIVKEY_KEY = 'encrypted_tss_priv_key';

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(base64Value) {
  const binary = atob(base64Value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function deriveEncryptionKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 210000,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function getEncryptedPrivKeyStorageKey(walletAddress) {
  return getStorageKey(ENCRYPTED_PRIVKEY_KEY, walletAddress);
}

async function readEncryptedPrivKeyRecord(walletAddress) {
  if (typeof window === 'undefined') return null;
  return escrowDB.getItem(getEncryptedPrivKeyStorageKey(walletAddress));
}

async function writeEncryptedPrivKeyRecord(walletAddress, record) {
  if (typeof window === 'undefined') return;
  await escrowDB.setItem(getEncryptedPrivKeyStorageKey(walletAddress), record);
}

export const getStorageKey = (key, walletAddress) => {
  const scope = resolveStorageScope(walletAddress);
  return `${scope}_${key}`;
};

export const savePrivKey = (privKey, walletAddress) => {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  window.sessionStorage.setItem(getStorageKey('tss_priv_key', walletAddress), privKey);
};

export const saveEncryptedPrivKey = async (privKey, walletAddress, passphrase) => {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Crypto API is not available in this browser');
  }

  if (!privKey) throw new Error('Private share is required');
  if (!passphrase) throw new Error('Passphrase is required');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(privKey)
  );

  await writeEncryptedPrivKeyRecord(walletAddress, {
    version: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });

  savePrivKey(privKey, walletAddress);
};

export const unlockEncryptedPrivKey = async (walletAddress, passphrase) => {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('Crypto API is not available in this browser');
  }

  if (!passphrase) throw new Error('Passphrase is required');

  const record = await readEncryptedPrivKeyRecord(walletAddress);
  if (!record) return null;

  const key = await deriveEncryptionKey(passphrase, base64ToBytes(record.salt));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.ciphertext)
  );

  const privKey = decoder.decode(plaintext);
  savePrivKey(privKey, walletAddress);
  return privKey;
};

export const clearPrivKey = (walletAddress) => {
  if (typeof window === 'undefined') return;
  if (window.sessionStorage) {
    window.sessionStorage.removeItem(getStorageKey('tss_priv_key', walletAddress));
  }
};

export const clearEncryptedPrivKey = async (walletAddress) => {
  if (typeof window === 'undefined') return;
  await escrowDB.removeItem(getEncryptedPrivKeyStorageKey(walletAddress));
};

export const hasEncryptedPrivKey = async (walletAddress) => {
  const record = await readEncryptedPrivKeyRecord(walletAddress);
  return Boolean(record);
};

export const getPrivKey = (walletAddress) => {
  if (typeof window === 'undefined') return null;

  const scopedValue = window.sessionStorage?.getItem(getStorageKey('tss_priv_key', walletAddress));
  if (scopedValue) return scopedValue;

  return migrateLegacyRoleScopedLocalStorageItem('tss_priv_key', walletAddress);
};

export const savePubKey = (pubKey, walletAddress) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(getStorageKey('tss_pub_key', walletAddress), pubKey);
};

export const getPubKey = (walletAddress) => {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  const scopedValue = window.localStorage.getItem(getStorageKey('tss_pub_key', walletAddress));
  if (scopedValue) return scopedValue;

  return migrateLegacyRoleScopedLocalStorageItem('tss_pub_key', walletAddress);
};

// ============================================================================
// PHẦN 2: LOGIC INDEXEDDB (SESSION RECOVERY) TÍCH HỢP LOCAL TEST
// ============================================================================
const escrowDB = localforage.createInstance({
  name: 'TssEscrowDApp',
  storeName: 'escrow_sessions' 
});

function getNonceRecordKey(nonceKey) {
  return `nonce_${nonceKey}`;
}

export const saveNonceRecord = async (nonceKey, nonceHex) => {
  if (!nonceKey || !nonceHex) return;

  try {
    await escrowDB.setItem(getNonceRecordKey(nonceKey), {
      nonceHex,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('[Storage Error] Khong the luu nonce:', err);
  }
};

export const getNonceRecord = async (nonceKey) => {
  if (!nonceKey) return null;

  try {
    const record = await escrowDB.getItem(getNonceRecordKey(nonceKey));
    return record?.nonceHex || null;
  } catch (err) {
    console.error('[Storage Error] Khong the doc nonce:', err);
    return null;
  }
};

export const clearNonceRecord = async (nonceKey) => {
  if (!nonceKey) return;

  try {
    await escrowDB.removeItem(getNonceRecordKey(nonceKey));
  } catch (err) {
    console.error('[Storage Error] Khong the xoa nonce:', err);
  }
};

export const saveSession = async (escrowId, data, walletAddress) => {
  try {
    const dbKey = getStorageKey(`session_${escrowId}`, walletAddress);
    await escrowDB.setItem(dbKey, data);
  } catch (err) {
    console.error('[Storage Error] Không thể lưu session:', err);
  }
};

export const getSession = async (escrowId, walletAddress) => {
  try {
    const scopedKey = getStorageKey(`session_${escrowId}`, walletAddress);
    const scopedSession = await escrowDB.getItem(scopedKey);
    if (scopedSession) return scopedSession;

    const legacySession = await escrowDB.getItem(getLegacyRoleScopedSessionKey(escrowId));
    if (!legacySession) return null;

    await escrowDB.setItem(scopedKey, legacySession);
    return legacySession;
  } catch (err) {
    console.error('[Storage Error] Không thể đọc session:', err);
    return null;
  }
};

export const clearSession = async (escrowId, walletAddress) => {
  try {
    const dbKey = getStorageKey(`session_${escrowId}`, walletAddress);
    await escrowDB.removeItem(dbKey);
  } catch (err) {
    console.error('[Storage Error] Không thể xóa session:', err);
  }
};
