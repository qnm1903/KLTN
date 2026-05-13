// 1. ABI của Factory (Dùng trực tiếp mảng chuỗi cho ethers.js)
export const factoryAbi = [
  'function createEscrow(address seller, address[5] calldata mediators, uint256[2] calldata pkAggCoords, uint256 amount, uint256 confirmDays, uint256 timeoutDays) external returns (address)',
  'event EscrowCreatedEvent(address escrowAddress, bytes32 escrowId, address buyer, address seller, address[5] mediators)',
  'function escrowsByBuyer(address) external view returns (address[])',
  'function escrowsBySeller(address) external view returns (address[])'
];

// 2. ABI của MediatorPool (cho event listener)
export const mediatorPoolAbi = [
  'function mediators(address) external view returns (address wallet, uint256 stakeAmount, bool isActive, uint256 timeoutCount, uint256 reputationScore, uint256 totalVotes, uint256 successfulVotes)',
  'function requestRandomMediator(bytes32 escrowId, address buyer, address seller) external',
  'event RandomMediatorSelected(bytes32 indexed escrowId, address[] mediators)',
  'event RandomnessRequested(uint256 requestId, bytes32 indexed escrowId)',
  'event ReputationUpdated(address indexed mediator, uint256 oldScore, uint256 newScore)',
  'event MediatorSlashed(address indexed mediator, uint256 amount)'
];

// 3. ABI của Vault
export const vaultAbi = [
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
  'function lockFunds() external payable',
  'function release(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external',
  'function refund(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external',
  'function dispute() external',
  'function timeoutRelease(address rAddr, bytes32 z, bytes32 e, bytes32 msgHash, uint8 signerBitmap) external',
  'function signerCount(uint8 signerBitmap) external pure returns (uint8)',
  'function validateSignerBitmap(uint8 signerBitmap) external pure returns (bool)',
  'event EscrowCreated(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount)',
  'event FundsLocked(bytes32 indexed escrowId, uint256 amount)',
  'event FundsReleased(bytes32 indexed escrowId, address indexed recipient, uint8 signerBitmap, string action)',
  'event DisputeOpened(bytes32 indexed escrowId)'
];