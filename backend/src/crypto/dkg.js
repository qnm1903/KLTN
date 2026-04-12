import { aggregatePublicKeys } from './schnorr.js';

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 phút

export const PARTICIPANT_ROLES = [
  'buyer',
  'seller',
  'mediator1',
  'mediator2',
  'mediator3',
  'mediator4',
  'mediator5'
];

export const ACTION_SIGNER_SETS = {
  release: ['buyer', 'seller', 'mediator1', 'mediator2', 'mediator3'],
  refund: ['buyer', 'mediator1', 'mediator2', 'mediator3', 'mediator4'],
  timeout: ['seller', 'mediator2', 'mediator3', 'mediator4', 'mediator5']
};

const ROLE_BIT_POSITIONS = new Map(PARTICIPANT_ROLES.map((role, index) => [role, index]));

function assertRole(role) {
  if (!ROLE_BIT_POSITIONS.has(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
}

function normalizeRoles(roles) {
  return [...new Set(roles)].sort((left, right) => ROLE_BIT_POSITIONS.get(left) - ROLE_BIT_POSITIONS.get(right));
}

export function getActionSigners(action) {
  const roles = ACTION_SIGNER_SETS[action];
  if (!roles) {
    throw new Error(`Unsupported action: ${action}`);
  }
  return [...roles];
}

export function deriveSignerBitmap(roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('Signer roles are required');
  }

  return normalizeRoles(roles).reduce((bitmap, role) => {
    assertRole(role);
    return bitmap | (1 << ROLE_BIT_POSITIONS.get(role));
  }, 0);
}

export function aggregatePubKeysForRoles(pubKeysByRole, roles) {
  if (!pubKeysByRole || typeof pubKeysByRole !== 'object') {
    throw new Error('Public keys are required');
  }

  const orderedRoles = normalizeRoles(roles);
  const pubKeys = orderedRoles.map((role) => {
    assertRole(role);
    const pubKey = pubKeysByRole[role];
    if (!pubKey) {
      throw new Error(`Missing public key for role: ${role}`);
    }
    return pubKey;
  });

  const aggregate = aggregatePublicKeys(pubKeys);
  return { x: aggregate.x, y: aggregate.y };
}

/**
 * Khởi tạo session DKG từ 7 public keys do frontend cung cấp.
 *
 * @param {string} escrowId
 * @param {{ buyerPubKey, sellerPubKey, mediatorPubKeys, participants, contractAddress, chainId }} params
 * @returns {{ session }}
 */
export function initDKG(
  escrowId,
  {
    buyerPubKey,
    sellerPubKey,
    mediatorPubKeys,
    participants,
    contractAddress,
    chainId
  }
) {
  if (!buyerPubKey || !sellerPubKey || !Array.isArray(mediatorPubKeys) || mediatorPubKeys.length !== 5) {
    throw new Error('Seven participant public keys are required');
  }

  const session = {
    participants: participants || {},
    contractAddress: contractAddress || null,
    chainId: chainId ? BigInt(chainId).toString() : null,
    pubKeys: {
      buyer: buyerPubKey,
      seller: sellerPubKey,
      mediator1: mediatorPubKeys[0],
      mediator2: mediatorPubKeys[1],
      mediator3: mediatorPubKeys[2],
      mediator4: mediatorPubKeys[3],
      mediator5: mediatorPubKeys[4]
    },
    nonces: {},          // Round 1: { role: { R_x, R_y } }
    zShares: {},         // Round 2: { role: z_hex }
    signingRoles: null,  // 2 bên đang ký, set khi bắt đầu round 1
    signingAction: null,
    signingBitmap: null,
    completedActions: [],
    createdAt: Date.now(),
    status: 'INITIALIZED'
  };

  return {
    session
  };
}

/**
 * Lấy PKagg phù hợp cho các bên đang ký.
 */
export function getPkAggForRoles(session, roles) {
  if (!session?.pubKeys) {
    throw new Error('Session public keys are not available');
  }

  return aggregatePubKeysForRoles(session.pubKeys, roles);
}

export function hasExactActionSigners(action, roles) {
  const expected = getActionSigners(action).sort();
  const actual = normalizeRoles(roles);
  return expected.length === actual.length && expected.every((role, index) => role === actual[index]);
}