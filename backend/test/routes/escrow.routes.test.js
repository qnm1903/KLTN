import request from 'supertest';
import { ethers } from 'ethers';
import app from '../../src/app.js';
import { clearSessions } from '../../src/store/session.js';
import { computeSignatureShare } from '../../src/crypto/schnorr.js';

function buildParty() {
  const wallet = ethers.Wallet.createRandom();
  return {
    addr: wallet.address,
    priv: wallet.privateKey,
    pub: ethers.SigningKey.computePublicKey(wallet.privateKey, false)
  };
}

describe('Escrow Routes Integration', () => {
  const escrowId = '0x' + '12'.repeat(32);
  const signerBitmapRelease = 0x1f;
  const contractAddress = '0x00000000000000000000000000000000000000aa';
  const chainId = '31337';
  let buyer;
  let seller;
  let mediator1;
  let mediator2;
  let mediator3;
  let mediator4;
  let mediator5;

  beforeEach(async () => {
    buyer = buildParty();
    seller = buildParty();
    mediator1 = buildParty();
    mediator2 = buildParty();
    mediator3 = buildParty();
    mediator4 = buildParty();
    mediator5 = buildParty();
    await clearSessions();
  });

  afterEach(async () => {
    await clearSessions();
  });

  async function initSession() {
    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        chainId,
        contractAddress,
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddrs: [mediator1.addr, mediator2.addr, mediator3.addr, mediator4.addr, mediator5.addr],
        buyerPubKey: buyer.pub,
        sellerPubKey: seller.pub,
        mediatorPubKeys: [mediator1.pub, mediator2.pub, mediator3.pub, mediator4.pub, mediator5.pub]
      });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, contractAddress, chainId }));
  }

  it('rejects /init when pubkey does not match address', async () => {
    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        chainId,
        contractAddress,
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddrs: [mediator1.addr, mediator2.addr, mediator3.addr, mediator4.addr, mediator5.addr],
        buyerPubKey: seller.pub,
        sellerPubKey: seller.pub,
        mediatorPubKeys: [mediator1.pub, mediator2.pub, mediator3.pub, mediator4.pub, mediator5.pub]
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/buyerPubKey does not match buyerAddr/i);
  });

  it('rejects /init when a compressed public key is provided', async () => {
    const compressed = ethers.SigningKey.computePublicKey(buyer.priv, true);

    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        chainId,
        contractAddress,
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddrs: [mediator1.addr, mediator2.addr, mediator3.addr, mediator4.addr, mediator5.addr],
        buyerPubKey: compressed,
        sellerPubKey: seller.pub,
        mediatorPubKeys: [mediator1.pub, mediator2.pub, mediator3.pub, mediator4.pub, mediator5.pub]
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Compressed public keys are not supported/i);
  });

  it('rejects role-action mismatch on /nonce', async () => {
    await initSession();

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const r = computeSignatureShare(mediator5.priv, nonce, '0x' + '00'.repeat(32));

    const res = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId,
        role: 'mediator5',
        action: 'release',
        signerBitmap: signerBitmapRelease,
        R_x: r.R_x,
        R_y: r.R_y
      });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not allowed for action/i);
  });

  it('rejects switching action during an active round', async () => {
    await initSession();

    const nonceBuyer = ethers.hexlify(ethers.randomBytes(32));
    const rb = computeSignatureShare(buyer.priv, nonceBuyer, '0x' + '00'.repeat(32));

    const first = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId,
        role: 'buyer',
        action: 'release',
        signerBitmap: signerBitmapRelease,
        R_x: rb.R_x,
        R_y: rb.R_y
      });

    expect(first.statusCode).toBe(200);

    const second = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId,
        role: 'buyer',
        action: 'refund',
        signerBitmap: signerBitmapRelease,
        R_x: rb.R_x,
        R_y: rb.R_y
      });

    expect(second.statusCode).toBe(409);
    expect(second.body.error).toMatch(/already in progress/i);
  });

  it('rejects /sign when round 1 is not completed', async () => {
    await initSession();

    const res = await request(app)
      .post('/api/escrow/sign')
      .send({
        escrowId,
        role: 'buyer',
        signerBitmap: signerBitmapRelease,
        z: '0x' + '01'.padStart(64, '0')
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/round 1 not completed/i);
  });

  it('completes release signing in 2 rounds and returns final signature', async () => {
    await initSession();

    const zero = '0x' + '00'.repeat(32);
    const releaseRoles = [
      { role: 'buyer', party: buyer },
      { role: 'seller', party: seller },
      { role: 'mediator1', party: mediator1 },
      { role: 'mediator2', party: mediator2 },
      { role: 'mediator3', party: mediator3 }
    ];

    const round1 = releaseRoles.map((entry) => {
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const share = computeSignatureShare(entry.party.priv, nonce, zero);
      return { ...entry, nonce, share };
    });

    let challenge = null;
    for (let index = 0; index < round1.length; index++) {
      const nonceResponse = await request(app)
        .post('/api/escrow/nonce')
        .send({
          escrowId,
          role: round1[index].role,
          action: 'release',
          signerBitmap: signerBitmapRelease,
          R_x: round1[index].share.R_x,
          R_y: round1[index].share.R_y
        });

      expect(nonceResponse.statusCode).toBe(200);
      if (index < round1.length - 1) {
        expect(nonceResponse.body).toEqual({ received: index + 1, needed: 5 });
      } else {
        expect(nonceResponse.body).toHaveProperty('challenge');
        expect(nonceResponse.body).toHaveProperty('msgHash');
        challenge = nonceResponse.body.challenge;
      }
    }

    let finalSig = null;
    for (let index = 0; index < round1.length; index++) {
      const z = computeSignatureShare(round1[index].party.priv, round1[index].nonce, challenge).z;
      const signResponse = await request(app)
        .post('/api/escrow/sign')
        .send({
          escrowId,
          role: round1[index].role,
          signerBitmap: signerBitmapRelease,
          z
        });

      expect(signResponse.statusCode).toBe(200);
      if (index < round1.length - 1) {
        expect(signResponse.body).toEqual({ received: index + 1, needed: 5 });
      } else {
        finalSig = signResponse.body;
      }
    }

    expect(finalSig).toBeDefined();
    expect(finalSig).toHaveProperty('R_addr');
    expect(finalSig).toHaveProperty('z');
    expect(finalSig).toHaveProperty('e');
    expect(finalSig).toHaveProperty('msgHash');
    expect(finalSig.signerBitmap).toBe(signerBitmapRelease);

    const status = await request(app).get(`/api/escrow/${escrowId}/status`);
    expect(status.statusCode).toBe(200);
    expect(status.body.completedActions).toContain('release');
    expect(status.body.signingAction).toBeNull();
  });
});
