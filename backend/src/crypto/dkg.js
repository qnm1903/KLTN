import EC_Module from 'elliptic';
import Secrets from 'secrets.js-grempe';
import { getPublicKey, pubKeyToAddress } from './ecc.js';

const ec = new EC_Module.ec('secp256k1');

export async function initDKG(escrowId, sessionStore) {
  // 1. Sinh private key ngẫu nhiên s
  const keyPair = ec.genKeyPair();
  let s = keyPair.getPrivate('hex');               // private key gốc

  // 2. Shamir SSS: chia s thành 3 shares, threshold = 2
  const sharesHex = Secrets.share(s, 3, 2);        // [ share1, share2, share3 ]
  // sharesHex[i] là hex string; Secrets.combine([any 2]) sẽ trả về s

  // 3. Tính PKagg và Ethereum address của nó
  const pkAggHex = getPublicKey(s);            // uncompressed pubkey hex
  const pkAggAddress = pubKeyToAddress(pkAggHex);  // 0x... Ethereum address

  // 4. Lưu session (Không lưu s, chỉ lưu address và shares tạm)
  sessionStore.set(escrowId, {
    pkAggAddress,
    pkAggHex,
    shares: {
      buyer: { index: 1, share: sharesHex[0] },
      seller: { index: 2, share: sharesHex[1] },
      mediator: { index: 3, share: sharesHex[2] }
    },
    partialShares: [],  // sẽ nhận lại khi cần ký
    status: 'INITIALIZED'
  });

  // 5. Xóa s
  s = null;

  return {
    pkAggAddress,       // lưu vào Smart Contract
    buyerShare: sharesHex[0],
    sellerShare: sharesHex[1],
    mediatorShare: sharesHex[2]
  };
}