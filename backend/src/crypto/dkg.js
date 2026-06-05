import { aggregatePublicKeys, aggregatePubKeysWithLagrange } from './schnorr.js';

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 phút (DKG phase)
export const SIGNING_TTL_MS = 6 * 60 * 60 * 1000; // 6 giờ (signing phase)

export const PARTICIPANT_ROLES = [
  'buyer',
  'seller',
  'mediator1',
  'mediator2',
  'mediator3',
  'mediator4',
  'mediator5'
];

/**
 * Mapping từ Role sang ID cho Shamir Secret Sharing (SSS).
 * Mỗi role có một số ID cố định để tính Lagrange coefficients.
 */
export const ROLE_TO_ID = {
  'buyer': 1,
  'seller': 2,
  'mediator1': 3,
  'mediator2': 4,
  'mediator3': 5,
  'mediator4': 6,
  'mediator5': 7
};



const ROLE_BIT_POSITIONS = new Map(PARTICIPANT_ROLES.map((role, index) => [role, index]));

function createEmptyPubKeyMap() {
  return PARTICIPANT_ROLES.reduce((accumulator, role) => {
    accumulator[role] = null;
    return accumulator;
  }, {});
}

function assertRole(role) {
  if (!ROLE_BIT_POSITIONS.has(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
}

/**
 * Lấy mảng ID từ mảng roles.
 * @param {string[]} roles - mảng role
 * @returns {number[]} mảng ID tương ứng
 */
export function getRoleIds(roles) {
  return roles.map(role => {
    const id = ROLE_TO_ID[role];
    if (id === undefined) throw new Error(`Unknown role: ${role}`);
    return id;
  });
}

function normalizeRoles(roles) {
  return [...new Set(roles)].sort((left, right) => ROLE_BIT_POSITIONS.get(left) - ROLE_BIT_POSITIONS.get(right));
}


function normalizePubKeyMap(session) {
  const normalized = createEmptyPubKeyMap();
  if (!session?.pubKeys || typeof session.pubKeys !== 'object') {
    return normalized;
  }

  for (const role of PARTICIPANT_ROLES) {
    if (session.pubKeys[role]) {
      normalized[role] = session.pubKeys[role];
    }
  }

  return normalized;
}

export function countCollectedPubKeys(session) {
  const pubKeys = normalizePubKeyMap(session);
  return PARTICIPANT_ROLES.filter((role) => Boolean(pubKeys[role])).length;
}

export function getMissingPubKeyRoles(session) {
  const pubKeys = normalizePubKeyMap(session);
  return PARTICIPANT_ROLES.filter((role) => !pubKeys[role]);
}

export function isPubKeySetComplete(session) {
  return getMissingPubKeyRoles(session).length === 0;
}

export function getPubKeyCollectionSummary(session, now = Date.now()) {
  const required = PARTICIPANT_ROLES.length;
  const missingRoles = getMissingPubKeyRoles(session);
  const received = required - missingRoles.length;
  const dueAt = Number(session?.pubKeyCollectionDueAt || (Number(session?.createdAt || now) + SESSION_TTL_MS));
  const complete = missingRoles.length === 0;
  const expired = !complete && now > dueAt;

  let state = complete ? 'COMPLETE' : received > 0 ? 'PARTIAL' : 'PENDING';
  if (expired) {
    state = 'EXPIRED';
  }

  return {
    state,
    required,
    received,
    missingRoles,
    dueAt,
    complete,
    expired
  };
}

export function syncPubKeyCollectionState(session, now = Date.now()) {
  if (!session || typeof session !== 'object') {
    return getPubKeyCollectionSummary(null, now);
  }

  const summary = getPubKeyCollectionSummary(session, now);
  session.pubKeyCollectionState = summary.state;
  if (!session.pubKeyCollectionDueAt) {
    session.pubKeyCollectionDueAt = summary.dueAt;
  }
  return summary;
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
  // Use Lagrange-weighted aggregation by default (SSS)
  const aggregate = aggregatePubKeysWithLagrange(pubKeysByRole, orderedRoles, ROLE_TO_ID);
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

  const createdAt = Date.now();
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
    createdAt,
    pubKeyCollectionState: 'COMPLETE',
    pubKeyCollectionDueAt: createdAt + SESSION_TTL_MS,
    pubKeyAggregationCompletedAt: createdAt,
    status: 'INITIALIZED'
  };

  return {
    session
  };
}

export function initIncrementalDKG(
  escrowId,
  {
    participants,
    contractAddress,
    chainId,
    dueAtMs
  }
) {
  if (!participants?.buyer || !participants?.seller || !Array.isArray(participants?.mediators) || participants.mediators.length !== 5) {
    throw new Error('Escrow participants are incomplete for incremental initialization');
  }

  const createdAt = Date.now();
  const dueAt = Number(dueAtMs || (createdAt + SESSION_TTL_MS));
  const session = {
    participants,
    contractAddress: contractAddress || null,
    chainId: chainId ? BigInt(chainId).toString() : null,
    pubKeys: createEmptyPubKeyMap(),
    nonces: {},
    zShares: {},
    signingRoles: null,
    signingAction: null,
    signingBitmap: null,
    completedActions: [],
    createdAt,
    pubKeyCollectionState: 'PENDING',
    pubKeyCollectionDueAt: dueAt,
    pubKeyAggregationCompletedAt: null,
    precomputedPkAgg: null,
    status: 'INITIALIZED'
  };

  return { session };
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
