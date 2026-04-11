import localforage from 'localforage';

// ============================================================================
// PHẦN 1: LOGIC LOCAL TEST & LƯU TRỮ KEY 
// ============================================================================
const IS_LOCAL_TEST_MODE = true; 

export const getStorageKey = (key) => {
  if (!IS_LOCAL_TEST_MODE) return key;
  
  // Nếu đang test local, lấy role từ URL (vd: ?role=buyer) để làm tiền tố
  const urlParams = new URLSearchParams(window.location.search);
  const role = urlParams.get('role') || 'default';
  return `${role}_${key}`; 
};

export const savePrivKey = (privKey) => {
  localStorage.setItem(getStorageKey('tss_priv_key'), privKey);
};

export const getPrivKey = () => {
  return localStorage.getItem(getStorageKey('tss_priv_key'));
};

export const savePubKey = (pubKey) => {
  localStorage.setItem(getStorageKey('tss_pub_key'), pubKey);
};

export const getPubKey = () => {
  return localStorage.getItem(getStorageKey('tss_pub_key'));
};

// ============================================================================
// PHẦN 2: LOGIC INDEXEDDB (SESSION RECOVERY) TÍCH HỢP LOCAL TEST
// ============================================================================
const escrowDB = localforage.createInstance({
  name: 'TssEscrowDApp',
  storeName: 'escrow_sessions' 
});

export const saveSession = async (escrowId, data) => {
  try {
    // Áp dụng getStorageKey để cô lập session giữa 3 tab (buyer, seller, mediator)
    const dbKey = getStorageKey(`session_${escrowId}`);
    await escrowDB.setItem(dbKey, data);
  } catch (err) {
    console.error('[Storage Error] Không thể lưu session:', err);
  }
};

export const getSession = async (escrowId) => {
  try {
    const dbKey = getStorageKey(`session_${escrowId}`);
    return await escrowDB.getItem(dbKey);
  } catch (err) {
    console.error('[Storage Error] Không thể đọc session:', err);
    return null;
  }
};

export const clearSession = async (escrowId) => {
  try {
    const dbKey = getStorageKey(`session_${escrowId}`);
    await escrowDB.removeItem(dbKey);
  } catch (err) {
    console.error('[Storage Error] Không thể xóa session:', err);
  }
};