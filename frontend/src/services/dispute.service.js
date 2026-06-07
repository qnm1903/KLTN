import api from '../lib/api.js';

/**
 * createDispute
 * POST /api/disputes
 * @param {Object} payload - CreateDisputeRequest
 * @returns {Promise<Object>} CreateDisputeResponse
 *
 * CreateDisputeRequest:
 * { escrowId, initiatorAddress, reason, description?, evidenceRefs?, onChainTxHash? }
 */
export async function createDispute(payload) {
  const res = await api.post('/disputes', payload);
  return res.data;
}

/**
 * getDispute
 * GET /api/disputes/:id
 * @param {string} disputeId
 * @returns {Promise<Object>} Dispute
 */
export async function getDispute(disputeId) {
  const res = await api.get(`/disputes/${encodeURIComponent(disputeId)}`);
  return res.data;
}

/**
 * uploadEvidence
 * POST /api/disputes/:id/evidence (multipart/form-data)
 * @param {string} disputeId
 * @param {FormData} formData - chứa file + metadata fields (uploaderAddress, description, confidential, signature)
 * @returns {Promise<Object>} EvidenceUploadResponse
 */
export async function uploadEvidence(disputeId, formData) {
  // Fetch dispute to get escrowId
  const disputeRes = await api.get(`/disputes/${encodeURIComponent(disputeId)}`);
  const dispute = disputeRes.data;
  if (!dispute?.escrowId) {
    throw new Error('Cannot determine escrowId from dispute');
  }

  // Do NOT set Content-Type manually — axios sets it with the correct multipart boundary for FormData
  const res = await api.post(`/escrows/${encodeURIComponent(dispute.escrowId)}/evidence`, formData);
  // Add escrowId + disputeId to response for FE convenience
  return { ...res.data, escrowId: dispute.escrowId, disputeId };
}

/**
 * getEvidenceList
 * Lấy danh sách evidence dựa trên escrowId của dispute
 * @param {string} disputeId
 * @returns {Promise<Array>} array of Evidence
 */
export async function getEvidenceList(disputeId) {
  const disputeRes = await api.get(`/disputes/${encodeURIComponent(disputeId)}`);
  const dispute = disputeRes.data;
  
  if (!dispute?.escrowId) {
    return []; 
  }

  const res = await api.get(`/escrows/${encodeURIComponent(dispute.escrowId)}/evidence`);
  return res.data;
}

/**
 * acceptMediator
 * POST /api/disputes/:id/accept-mediator
 * @param {string} disputeId
 * @param {Object} payload - { mediator, signature, timestamp }
 * @returns {Promise<Object>} AcceptMediatorResponse
 */
export async function acceptMediator(disputeId, payload) {
  const path = `/disputes/${encodeURIComponent(disputeId)}/accept-mediator`;
  console.log('🚀 [dispute.service] POST ->', path); // Log đường dẫn để kiểm tra
  const res = await api.post(path, payload);
  return res.data;
}

/**
 * submitVote
 * POST /api/disputes/:id/vote
 * @param {string} disputeId
 * @param {Object} payload - VoteSubmitRequest { mediator, vote, justification, evidenceRefs, timestamp, signature, schnorrSigRefund?, schnorrSigRelease? }
 * @returns {Promise<Object>} VoteSubmitResponse
 */
export async function submitVote(disputeId, payload) {
  const res = await api.post(`/disputes/${encodeURIComponent(disputeId)}/vote`, payload);
  return res.data;
}

/**
 * getCurrentMediatorNonce
 * GET /api/disputes/nonce/current
 * @returns {Promise<Object>} CurrentMediatorNonceResponse
 */
export async function getCurrentMediatorNonce() {
  const res = await api.get('/disputes/nonce/current');
  return res.data;
}

/**
 * signEvidence
 * POST /api/disputes/:id/evidence/:evidenceId/signature
 * @param {string} disputeId
 * @param {string} evidenceId
 * @param {Object} payload - { signature, message }
 * @returns {Promise<Object>} SignedEvidence
 */
export async function signEvidence(disputeId, evidenceId, payload) {
  const res = await api.post(
    `/disputes/${encodeURIComponent(disputeId)}/evidence/${encodeURIComponent(evidenceId)}/signature`,
    payload
  );
  return res.data;
}

/**
 * Convenience default export
 */
const disputeService = {
  createDispute,
  getDispute,
  uploadEvidence,
  getEvidenceList,
  acceptMediator,
  submitVote,
  getCurrentMediatorNonce,
  signEvidence
};

export default disputeService;