import { parseAbi } from 'viem';

// 1. ABI của Factory
export const factoryAbi = parseAbi([
  // Hàm tạo Ký quỹ
  'function createEscrow(address seller, address[5] calldata mediators, uint256[2] calldata pkAggCoords, uint256 amount, uint256 confirmDays, uint256 timeoutDays) external returns (address)',
  // Sự kiện (Event) khi tạo thành công
  'event EscrowCreatedEvent(address escrowAddress, bytes32 escrowId, address buyer, address seller, address[5] mediators)',
  // Lấy danh sách hợp đồng theo user
  'function escrowsByBuyer(address) external view returns (address[])',
  'function escrowsBySeller(address) external view returns (address[])'
]);

// 2. ABI của Vault 
export const vaultAbi = parseAbi([
  // State accessors
  'function escrowId() external view returns (bytes32)',
  'function buyer() external view returns (address)',
  'function seller() external view returns (address)',
  'function mediators(uint256) external view returns (address)',
  'function pkAggX() external view returns (uint256)',
  'function pkAggY() external view returns (uint256)',
  'function amount() external view returns (uint256)',
  'function status() external view returns (uint8)',
  'function confirmDeadline() external view returns (uint256)',
  'function timeoutDeadline() external view returns (uint256)',
  
  // State-changing functions
  'function lockFunds() external payable',
  'function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external',
  'function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external',
  'function dispute() external',
  'function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external',
  
  // Utility functions
  'function signerCount(uint8 signerBitmap) external pure returns (uint8)',
  'function validateSignerBitmap(uint8 signerBitmap) external pure returns (bool)',
  
  // Events
  'event EscrowCreated(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount)',
  'event FundsLocked(bytes32 indexed escrowId, uint256 amount)',
  'event FundsReleased(bytes32 indexed escrowId, address indexed recipient, uint8 signerBitmap, string action)',
  'event DisputeOpened(bytes32 indexed escrowId)'
]);