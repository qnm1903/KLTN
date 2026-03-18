import request from 'supertest';
import { ethers } from 'ethers';
import app from '../../src/app.js';
import { sessions } from '../../src/store/session.js';
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
  let buyer;
  let seller;
  let mediator;

  beforeEach(() => {
    buyer = buildParty();
    seller = buildParty();
    mediator = buildParty();
    sessions.clear();
  });

  afterEach(() => {
    sessions.clear();
  });

  async function initSession() {
    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddr: mediator.addr,
        buyerPubKey: buyer.pub,
        sellerPubKey: seller.pub,
        mediatorPubKey: mediator.pub
      });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('pkAgg_bs');
  }

  it('rejects /init when pubkey does not match address', async () => {
    const res = await request(app)
      .post('/api/escrow/init')
      .send({
        escrowId,
        buyerAddr: buyer.addr,
        sellerAddr: seller.addr,
        mediatorAddr: mediator.addr,
        buyerPubKey: seller.pub,
        sellerPubKey: seller.pub,
        mediatorPubKey: mediator.pub
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/buyerPubKey does not match buyerAddr/i);
  });

  it('rejects role-action mismatch on /nonce', async () => {
    await initSession();

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const r = computeSignatureShare(mediator.priv, nonce, '0x' + '00'.repeat(32));

    const res = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId,
        role: 'mediator',
        action: 'release',
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
        z: '0x' + '01'.padStart(64, '0')
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/round 1 not completed/i);
  });

  it('completes release signing in 2 rounds and returns final signature', async () => {
    await initSession();

    const zero = '0x' + '00'.repeat(32);
    const nonceBuyer = ethers.hexlify(ethers.randomBytes(32));
    const nonceSeller = ethers.hexlify(ethers.randomBytes(32));

    const rb = computeSignatureShare(buyer.priv, nonceBuyer, zero);
    const rs = computeSignatureShare(seller.priv, nonceSeller, zero);

    const n1 = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId,
        role: 'buyer',
        action: 'release',
        R_x: rb.R_x,
        R_y: rb.R_y
      });

    expect(n1.statusCode).toBe(200);
    expect(n1.body).toEqual({ received: 1, needed: 2 });

    const n2 = await request(app)
      .post('/api/escrow/nonce')
      .send({
        escrowId,
        role: 'seller',
        action: 'release',
        R_x: rs.R_x,
        R_y: rs.R_y
      });

    expect(n2.statusCode).toBe(200);
    expect(n2.body).toHaveProperty('challenge');
    expect(n2.body).toHaveProperty('msgHash');

    const zb = computeSignatureShare(buyer.priv, nonceBuyer, n2.body.challenge).z;
    const zs = computeSignatureShare(seller.priv, nonceSeller, n2.body.challenge).z;

    const s1 = await request(app)
      .post('/api/escrow/sign')
      .send({
        escrowId,
        role: 'buyer',
        z: zb
      });

    expect(s1.statusCode).toBe(200);
    expect(s1.body).toEqual({ received: 1, needed: 2 });

    const s2 = await request(app)
      .post('/api/escrow/sign')
      .send({
        escrowId,
        role: 'seller',
        z: zs
      });

    expect(s2.statusCode).toBe(200);
    expect(s2.body).toHaveProperty('R_addr');
    expect(s2.body).toHaveProperty('z');
    expect(s2.body).toHaveProperty('e');
    expect(s2.body).toHaveProperty('msgHash');

    const status = await request(app).get(`/api/escrow/${escrowId}/status`);
    expect(status.statusCode).toBe(200);
    expect(status.body.completedActions).toContain('release');
    expect(status.body.signingAction).toBeNull();
  });
});
