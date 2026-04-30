import React from 'react';
import { useAtomValue } from 'jotai';
import { evidenceListAtom } from '../../store/disputeAtoms.js';

/**
 * EvidenceTimeline
 * - Dùng useAtomValue(evidenceListAtom) để lấy array of Evidence.
 * - Hiển thị card timeline: description, uploadedAt, uploader, verified badge.
 */
const EvidenceTimeline = () => {
  const evidences = useAtomValue(evidenceListAtom) || [];

  if (!evidences || evidences.length === 0) {
    return (
      <div className="p-6 bg-white rounded-lg shadow">
        <div className="text-sm text-gray-500">Chưa có Evidence. Parties có thể upload Evidence để hỗ trợ dispute.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {evidences.map((ev) => (
        <div key={ev.id} className="bg-white rounded-lg shadow p-4 flex items-start space-x-4">
          <div className="w-12 h-12 rounded-md bg-gray-50 flex items-center justify-center text-sm font-medium text-gray-700">
            {/* Thumbnail placeholder */}
            {ev.metadata && ev.metadata.name ? ev.metadata.name.slice(0, 2).toUpperCase() : 'EV'}
          </div>

          <div className="flex-1">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-gray-800">{ev.description || 'No description'}</div>
                <div className="text-xs text-gray-500 mt-1">
                  Uploaded by <span className="font-mono text-gray-700">{truncateAddr(ev.uploader)}</span> • {formatDate(ev.uploadedAt)}
                </div>
              </div>

              <div className="flex items-center space-x-3">
                {/* Verified badge mock */}
                <div className="flex items-center space-x-2">
                  <span className="px-2 py-1 bg-green-50 text-green-700 text-xs rounded-full">Verified</span>
                </div>
              </div>
            </div>

            {/* Optional metadata */}
            {ev.metadata ? (
              <div className="mt-3 text-xs text-gray-500">
                {ev.metadata.name} • {ev.metadata.mime} • {(ev.metadata.size / 1024).toFixed(1)} KB
              </div>
            ) : null}

            {/* IPFS link */}
            <div className="mt-3">
              <a
                className="text-xs text-indigo-600 hover:underline"
                href={ev.ipfsHash ? ev.ipfsHash.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/') : '#'}
                target="_blank"
                rel="noreferrer"
              >
                View on IPFS
              </a>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

/* Helpers */
function truncateAddr(addr = '', front = 6, back = 4) {
  if (!addr) return '';
  if (addr.length <= front + back) return addr;
  return `${addr.slice(0, front)}...${addr.slice(-back)}`;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso || '';
  }
}

export default EvidenceTimeline;