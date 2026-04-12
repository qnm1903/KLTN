import { parseAbi } from 'viem';

// 1. ABI của Factory (Nâng cấp để nhận mảng Mediators cho TSS 5-of-7)
export const factoryAbi = parseAbi([
  // [FIX CHÍNH]: address mediator -> address[] calldata mediators
  'function createEscrow(address seller, address[] calldata mediators, uint256[6] calldata pkAggCoords, uint256 amount, uint256 confirmDays, uint256 timeoutDays) external returns (address)',
  
  'event EscrowCreatedEvent(address escrowAddress, bytes32 escrowId, address buyer, address seller)',
  'function escrowsByBuyer(address) external view returns (address[])',
  'function escrowsBySeller(address) external view returns (address[])'
]);

// 2. ABI của Vault 
export const vaultAbi = parseAbi([
  'function lockFunds() external payable',
  'function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external',
  'function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external',
  'function dispute() external',
  'function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external',
  
  'function status() external view returns (uint8)',
  'function amount() external view returns (uint256)',
  'function buyer() external view returns (address)',
  'function seller() external view returns (address)',
  'function mediator() external view returns (address)', // Lưu ý: Ở smart contract (.sol) hàm này cũng sẽ phải đổi thành mảng nếu bạn muốn view
  'function confirmDeadline() external view returns (uint256)',
  'function timeoutDeadline() external view returns (uint256)'
]);