import request from 'supertest';
import { ethers } from 'ethers';
import app from '../../src/app.js';
import { clearSessions, saveSession } from '../../src/store/session.js';
import { initIncrementalDKG } from '../../src/crypto/dkg.js';
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
    expect(res.body.ok).toBe(true);
    expect(res.body.chainId).toBe(chainId);
    expect(String(res.body.contractAddress).toLowerCase()).toBe(contractAddress.toLowerCase());
  }

  async function initIncrementalSession(customEscrowId, options = {}) {
    const participants = {
      buyer: buyer.addr.toLowerCase(),
      seller: seller.addr.toLowerCase(),
      mediators: [
        mediator1.addr.toLowerCase(),
        mediator2.addr.toLowerCase(),
        mediator3.addr.toLowerCase(),
        mediator4.addr.toLowerCase(),
        mediator5.addr.toLowerCase()
      ]
    };

    const { session } = initIncrementalDKG(customEscrowId, {
      participants,
      contractAddress,
      chainId,
      dueAtMs: options.dueAtMs || Date.now() + (30 * 60 * 1000)
    });

    session.parties = participants;
    await saveSession(customEscrowId, session);
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

  it('rejects /init when chainId is invalid', async () => {
    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        chainId: 'not-a-chain-id',
        contractAddress,
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddrs: [mediator1.addr, mediator2.addr, mediator3.addr, mediator4.addr, mediator5.addr],
        buyerPubKey: buyer.pub,
        sellerPubKey: seller.pub,
        mediatorPubKeys: [mediator1.pub, mediator2.pub, mediator3.pub, mediator4.pub, mediator5.pub]
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid chainid/i);
  });

  it('rejects /init when contractAddress is invalid', async () => {
    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        chainId,
        contractAddress: 'not-an-address',
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddrs: [mediator1.addr, mediator2.addr, mediator3.addr, mediator4.addr, mediator5.addr],
        buyerPubKey: buyer.pub,
        sellerPubKey: seller.pub,
        mediatorPubKeys: [mediator1.pub, mediator2.pub, mediator3.pub, mediator4.pub, mediator5.pub]
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid contractaddress/i);
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

  it('collects pubkeys incrementally and marks collection complete after 7 submissions', async () => {
    const incrementalEscrowId = 'inc-' + ethers.hexlify(ethers.randomBytes(8)).slice(2);
    await initIncrementalSession(incrementalEscrowId);

    const submissions = [
      { role: 'buyer', pubKey: buyer.pub },
      { role: 'seller', pubKey: seller.pub },
      { role: 'mediator1', pubKey: mediator1.pub },
      { role: 'mediator2', pubKey: mediator2.pub },
      { role: 'mediator3', pubKey: mediator3.pub },
      { role: 'mediator4', pubKey: mediator4.pub },
      { role: 'mediator5', pubKey: mediator5.pub }
    ];

    for (let index = 0; index < submissions.length; index++) {
      const response = await request(app)
        .post('/api/escrow/pubkey/submit')
        .send({
          escrowId: incrementalEscrowId,
          role: submissions[index].role,
          pubKey: submissions[index].pubKey
        });

      expect(response.statusCode).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.isIdempotent).toBe(false);

      if (index < submissions.length - 1) {
        expect(response.body.state).toBe('PARTIAL');
      } else {
        expect(response.body.state).toBe('COMPLETE');
        expect(response.body.received).toBe(7);
      }
    }

    const status = await request(app).get(`/api/escrow/${incrementalEscrowId}/status`);
    expect(status.statusCode).toBe(200);
    expect(status.body.pubkeyCollection.state).toBe('COMPLETE');
    expect(status.body.pubkeyCollection.received).toBe(7);
  });

  it('treats duplicate submission with same key as idempotent success', async () => {
    const incrementalEscrowId = 'inc-' + ethers.hexlify(ethers.randomBytes(8)).slice(2);
    await initIncrementalSession(incrementalEscrowId);

    const first = await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'buyer', pubKey: buyer.pub });
    expect(first.statusCode).toBe(200);
    expect(first.body.isIdempotent).toBe(false);

    const duplicate = await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'buyer', pubKey: buyer.pub });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body.isIdempotent).toBe(true);
  });

  it('rejects duplicate role submission when pubkey differs', async () => {
    const incrementalEscrowId = 'inc-' + ethers.hexlify(ethers.randomBytes(8)).slice(2);
    await initIncrementalSession(incrementalEscrowId);

    const anotherBuyer = buildParty();

    const first = await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'buyer', pubKey: buyer.pub });
    expect(first.statusCode).toBe(200);

    const conflict = await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'buyer', pubKey: anotherBuyer.pub });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body.error).toMatch(/already submitted a different pubkey/i);
  });

  it('rejects pubkey submission if key does not match expected role address', async () => {
    const incrementalEscrowId = 'inc-' + ethers.hexlify(ethers.randomBytes(8)).slice(2);
    await initIncrementalSession(incrementalEscrowId);

    const mismatch = await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'seller', pubKey: buyer.pub });

    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body.error).toMatch(/does not match expected address/i);
  });

  it('rejects pubkey submission when collection is expired', async () => {
    const incrementalEscrowId = 'inc-' + ethers.hexlify(ethers.randomBytes(8)).slice(2);
    await initIncrementalSession(incrementalEscrowId, { dueAtMs: Date.now() - 1000 });

    const expired = await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'buyer', pubKey: buyer.pub });

    expect(expired.statusCode).toBe(410);
    expect(expired.body.error).toMatch(/collection expired/i);
    expect(expired.body.collection.state).toBe('EXPIRED');
  });

  it('blocks /nonce until all pubkeys are collected', async () => {
    const incrementalEscrowId = 'inc-' + ethers.hexlify(ethers.randomBytes(8)).slice(2);
    await initIncrementalSession(incrementalEscrowId);

    await request(app)
      .post('/api/escrow/pubkey/submit')
      .send({ escrowId: incrementalEscrowId, role: 'buyer', pubKey: buyer.pub });

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const share = computeSignatureShare(buyer.priv, nonce, '0x' + '00'.repeat(32));

    const res = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId: incrementalEscrowId,
        role: 'buyer',
        action: 'release',
        signerBitmap: signerBitmapRelease,
        R_x: share.R_x,
        R_y: share.R_y
      });

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/pubkey collection is incomplete/i);
  });
});
