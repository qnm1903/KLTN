// Biến cờ: Bật true nếu bạn test 3 tab trên cùng 1 máy tính, false nếu test thực tế
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

// --- PHẦN NÀY BẮT BUỘC PHẢI CÓ ĐỂ FIX LỖI ---

export const savePubKey = (pubKey) => {
  localStorage.setItem(getStorageKey('tss_pub_key'), pubKey);
};

export const getPubKey = () => {
  return localStorage.getItem(getStorageKey('tss_pub_key'));
};