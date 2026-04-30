// frontend/src/components/dispute/VRFLoadingState.jsx
// Component hiển thị trạng thái chờ Chainlink VRF chọn Mediators.
// Comment bằng tiếng Việt; giữ nguyên các thuật ngữ IT/Web3 (Chainlink VRF, spinner, on-chain, Etherscan, UI/UX).

import React from 'react';

const VRFLoadingState = ({ requestId = null, txHash = null, estimatedSeconds = 90 }) => {
  const formatEstimated = (s) => {
    if (!s || s <= 0) return 'Less than a minute';
    const m = Math.round(s / 60);
    if (m <= 1) return 'About 1 minute';
    return `About ${m} minutes`;
  };

  const etherscanUrl = txHash ? `https://etherscan.io/tx/${txHash}` : '#';

  return (
    <div className="w-full min-h-70 flex flex-col items-center justify-center bg-white rounded-lg shadow p-6">
      <div className="flex flex-col items-center space-y-6">
        {/* Large spinner */}
        <div className="w-28 h-28 rounded-full bg-gray-100 flex items-center justify-center">
          <svg className="w-16 h-16 text-indigo-600 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        </div>

        {/* Text */}
        <div className="text-center">
          <h3 className="text-xl font-semibold text-gray-800">
            Waiting for Chainlink VRF to select Mediators
          </h3>
          <p className="text-sm text-gray-500 mt-2 max-w-xl">
            Hệ thống đang chờ callback on-chain từ Chainlink VRF để chọn 7 Mediators cho dispute. Quá trình này có thể mất một vài phút.
          </p>
        </div>

        {/* Estimated time & links */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:space-x-4 space-y-2 sm:space-y-0">
          <div className="text-sm text-gray-600">
            <span className="font-medium">Estimated time:</span> {formatEstimated(estimatedSeconds)}
          </div>

          <a
            href={etherscanUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm px-4 py-2 bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100"
          >
            {txHash ? 'View tx on Etherscan' : 'View on-chain status'}
          </a>
        </div>

        {/* RequestId */}
        {requestId ? (
          <div className="text-xs text-gray-400 mt-2">
            <span className="font-medium">VRF RequestId:</span> {requestId}
          </div>
        ) : null}

        <div className="text-xs text-gray-400 mt-4 max-w-lg text-center">
          Nếu Chainlink VRF mất quá lâu, hãy kiểm tra trạng thái mạng hoặc liên hệ support. Admin có thể trigger retry nếu contract hỗ trợ.
        </div>
      </div>
    </div>
  );
};

export default VRFLoadingState;