import React, { useState, useRef } from 'react';
import { useAccount, useWalletClient } from 'wagmi';
import { getCurrentMediatorNonce, signEvidence, uploadEvidence } from '../../services/dispute.service.js';
import { sha256Hex } from '../../utils/signatureUtils.js';

/**
 * Props:
 * - isOpen: boolean
 * - onClose: function
 * - onUpload: optional function(payload) - nếu provided sẽ gọi khi upload
 * - disputeId: optional string - dispute id hiện tại
 */
export default function EvidenceUploadModal({ isOpen, onClose, onUpload, disputeId = '' }) {
  const [file, setFile] = useState(null);
  const [description, setDescription] = useState('');
  const [confidential, setConfidential] = useState(true);
  const [signMetadata, setSignMetadata] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();

  const fileInputRef = useRef(null);

  if (!isOpen) return null;

  const handleFileChange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setFile(f);
  };

  // Simple drag handlers
  const handleDrop = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  };


  const handleUpload = async () => {
    if (!file) {
      alert('Vui lòng chọn file trước khi upload.');
      return;
    }

    setUploading(true);

    try {
      // 0. Calculate file hash trước upload
      const fileHash = await sha256Hex(file);

      // 1. Upload file trước để lấy IPFS Hash
      const formData = new FormData();
      formData.append('file', file);
      formData.append('fileHash', fileHash);
      formData.append('uploaderAddress', address || '');
      formData.append('description', description || '');
      formData.append('confidential', confidential ? 'true' : 'false');

      const targetDisputeId = disputeId;
      const uploadRes = await uploadEvidence(targetDisputeId, formData);
      onUpload?.(uploadRes);
      console.log('[EvidenceUploadModal] upload result:', uploadRes);

      // 2. Ký ví sau khi ĐÃ CÓ ipfsHash (Vá lỗ hổng Cốt lõi 1)
      if (signMetadata) {
        if (!walletClient || !address) {
          alert('Wallet chưa kết nối. Vui lòng kết nối để ký metadata.');
          setUploading(false);
          return;
        }

        // Fetch current nonce trước ký
        const nonceRes = await getCurrentMediatorNonce();
        const nonce = Number(nonceRes?.currentNonce ?? 0);

        const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
        const metadataHash = '0x' + '0'.repeat(64);


        const message = {
          disputeId: targetDisputeId,
          escrowId: uploadRes.escrowId || '',
          evidenceId: uploadRes.evidenceId,
          fileHash,
          metadataHash,
          nonce,
          deadline
        };

        const signature = await walletClient.signTypedData({
          domain: {
            name: 'KLTNDisputeVoting',
            version: '1',
            chainId: 11155111,
            verifyingContract: '0x0000000000000000000000000000000000000000'
          },
          types: {
            EvidenceMeta: [
              { name: 'disputeId', type: 'string' },
              { name: 'escrowId', type: 'string' },
              { name: 'evidenceId', type: 'string' },
              { name: 'fileHash', type: 'bytes32' },
              { name: 'metadataHash', type: 'bytes32' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' }
            ]
          },
          primaryType: 'EvidenceMeta',
          message,
          account: address
        });

        // Gửi chữ ký lên Backend dùng api instance
        await signEvidence(targetDisputeId, uploadRes.evidenceId, {
          signature,
          message
        });
      }
    } catch (err) {
      console.error('Upload error', err);
      alert('Upload thất bại. Kiểm tra console.');
    } finally {
      setUploading(false);
      setFile(null);
      setDescription('');
      setConfidential(true);
      setSignMetadata(false);
      onClose?.();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !uploading && onClose?.()} />
      <div className="relative bg-white rounded-lg shadow-lg w-full max-w-2xl mx-4">
        <div className="px-6 py-4 border-b">
          <h3 className="text-lg font-semibold text-gray-800">Upload Evidence</h3>
          <p className="text-sm text-gray-500 mt-1">Upload file để lưu off-chain (mock). Có thể sign metadata với wallet (UI only).</p>
        </div>

        <div className="p-6 space-y-4">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="border-2 border-dashed border-gray-200 rounded-md p-6 flex items-center justify-between space-x-4"
          >
            <div className="flex-1">
              <div className="text-sm text-gray-700">
                Kéo & thả file vào đây hoặc nhấn nút để chọn file.
              </div>
              <div className="text-xs text-gray-500 mt-2">
                {file ? `${file.name} • ${(file.size / 1024).toFixed(1)} KB` : 'No file selected'}
              </div>
            </div>

            <div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm hover:bg-indigo-700"
                disabled={uploading}
              >
                Select File
              </button>
            </div>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-2 block w-full rounded-md border-gray-200 shadow-sm py-2 px-3 text-sm min-h-20"
              placeholder="Mô tả ngắn về Evidence..."
              disabled={uploading}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <label className="flex items-center space-x-2 text-sm">
                <input
                  type="checkbox"
                  checked={confidential}
                  onChange={(e) => setConfidential(e.target.checked)}
                  disabled={uploading}
                  className="h-4 w-4"
                />
                <span className="text-sm text-gray-700">Confidential</span>
              </label>

              <label className="flex items-center space-x-2 text-sm">
                <input
                  type="checkbox"
                  checked={signMetadata}
                  onChange={(e) => setSignMetadata(e.target.checked)}
                  disabled={uploading}
                  className="h-4 w-4"
                />
                <span className="text-sm text-gray-700">Sign metadata with wallet (UI only)</span>
              </label>
            </div>

            <div className="text-xs text-gray-400">Max file size: 25MB (mock)</div>
          </div>
        </div>

        <div className="px-6 py-4 border-t flex items-center justify-end space-x-3">
          <button
            onClick={() => !uploading && onClose?.()}
            className="px-4 py-2 rounded-md bg-gray-100 text-gray-700 text-sm hover:bg-gray-200"
            disabled={uploading}
          >
            Cancel
          </button>

          <button
            onClick={handleUpload}
            className="px-4 py-2 rounded-md bg-green-600 text-white text-sm hover:bg-green-700 flex items-center"
            disabled={uploading}
          >
            {uploading && <svg className="animate-spin mr-2 h-4 w-4" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" className="opacity-75" /></svg>}
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}