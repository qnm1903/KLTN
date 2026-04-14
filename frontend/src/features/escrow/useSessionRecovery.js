import { useEffect, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { escrowStatusAtom, signatureProgressAtom, signedNodesAtom, addSystemLogAtom } from './escrowStore';
import { getSession, saveSession } from '../../lib/storage';

/**
 * Custom Hook Auto-save và Rehydration tiến trình
 */
export const useSessionRecovery = (escrowId, walletAddress) => {
  // Cờ báo hiệu quá trình khôi phục đang diễn ra để khóa UI tạm thời
  const [recoveredScope, setRecoveredScope] = useState(null);
  
  const [status, setStatus] = useAtom(escrowStatusAtom);
  const [progress, setProgress] = useAtom(signatureProgressAtom);
  const [signedNodes, setSignedNodes] = useAtom(signedNodesAtom);
  const addLog = useSetAtom(addSystemLogAtom);
  const recoveryScope = escrowId && walletAddress ? `${escrowId}:${walletAddress}` : null;
  const isRecovering = recoveryScope !== null && recoveredScope !== recoveryScope;

  // 1. Giai đoạn Rehydration 
  useEffect(() => {
    const recoverData = async () => {
      if (!recoveryScope) {
        setRecoveredScope(null);
        return;
      }
      
      const savedSession = await getSession(escrowId, walletAddress);
      
      if (savedSession) {
        setStatus(savedSession.status);
        setProgress(savedSession.progress);
        setSignedNodes(savedSession.signedNodes);
        
        addLog({ 
          message: `Session recovered from local storage at ${new Date(savedSession.timestamp).toLocaleTimeString()}`, 
          type: 'warning' 
        });
      }
      setRecoveredScope(recoveryScope);
      // Dù có session hay không cũng phải gỡ cờ để UI render
    };

    recoverData();
  }, [escrowId, walletAddress, recoveryScope, setStatus, setProgress, setSignedNodes, addLog]);

  // 2. Giai đoạn Auto-save (Chụp Snapshot)
  // Mỗi khi các State quan trọng thay đổi, tự động lưu một bản sao xuống ổ cứng
  useEffect(() => {
    // Không lưu đè dữ liệu rỗng khi Hook vừa khởi tạo và đang trong quá trình khôi phục
    if (isRecovering || !escrowId || !walletAddress) return; 
    
    const snapshot = { 
      status, 
      progress, 
      signedNodes, 
      timestamp: Date.now() 
    };
    
    saveSession(escrowId, snapshot, walletAddress);
  }, [escrowId, walletAddress, isRecovering, status, progress, signedNodes]);

  return { isRecovering };
};