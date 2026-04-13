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

export const getStorageKey = (key, walletAddress) => {
  const scope = resolveStorageScope(walletAddress);
  return `${scope}_${key}`;
};

export const savePrivKey = (privKey, walletAddress) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(getStorageKey('tss_priv_key', walletAddress), privKey);
};

export const getPrivKey = (walletAddress) => {
  if (typeof window === 'undefined' || !window.localStorage) return null;

  const scopedValue = window.localStorage.getItem(getStorageKey('tss_priv_key', walletAddress));
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