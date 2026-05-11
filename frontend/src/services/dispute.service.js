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
  // Khi dùng axios với FormData, không set Content-Type boundary thủ công; axios sẽ tự thêm.
  const res = await api.post(`/disputes/${encodeURIComponent(disputeId)}/evidence`, formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  });
  return res.data;
}

/**
 * getEvidenceList
 * GET /api/disputes/:id/evidence
 * @param {string} disputeId
 * @returns {Promise<Array>} array of Evidence
 */
export async function getEvidenceList(disputeId) {
  const res = await api.get(`/disputes/${encodeURIComponent(disputeId)}/evidence`);
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
 * @param {Object} payload - VoteSubmitRequest { mediator, vote, justification, evidenceRefs, timestamp, signature }
 * @returns {Promise<Object>} VoteSubmitResponse
 */
export async function submitVote(disputeId, payload) {
  const res = await api.post(`/disputes/${encodeURIComponent(disputeId)}/vote`, payload);
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
  submitVote
};

export default disputeService;