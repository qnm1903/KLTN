import { parseAbi } from 'viem';

// 1. ABI của Factory (Dùng để Tạo Ký quỹ mới & Lấy danh sách)
export const factoryAbi = parseAbi([
  // Hàm tạo Ký quỹ
  'function createEscrow(address seller, address mediator, uint256[6] calldata pkAggCoords, uint256 amount, uint256 confirmDays, uint256 timeoutDays) external returns (address)',
  // Sự kiện (Event) khi tạo thành công
  'event EscrowCreatedEvent(address escrowAddress, bytes32 escrowId, address buyer, address seller)',
  // Lấy danh sách hợp đồng theo user
  'function escrowsByBuyer(address) external view returns (address[])',
  'function escrowsBySeller(address) external view returns (address[])'
]);

// 2. ABI của Vault (Dùng để Thao tác bên trong 1 Ký quỹ cụ thể)
export const vaultAbi = parseAbi([
  // Các hàm thay đổi trạng thái (Ghi lên Blockchain)
  'function lockFunds() external payable',
  'function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external',
  'function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external',
  'function dispute() external',
  'function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash) external',
  
  // Các hàm đọc thông tin (View/Read)
  'function status() external view returns (uint8)',
  'function amount() external view returns (uint256)',
  'function buyer() external view returns (address)',
  'function seller() external view returns (address)',
  'function mediator() external view returns (address)',
  'function confirmDeadline() external view returns (uint256)',
  'function timeoutDeadline() external view returns (uint256)'
]);