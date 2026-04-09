// Thay thế bằng địa chỉ Contract chính thức trên Sepolia Testnet
export const ESCROW_CONTRACT_ADDRESS = "0x1CB56be434B6A3c678FEDf82A7206e06845D93F0";

// Định nghĩa giao diện các hàm Smart Contract mà Frontend sẽ gọi
export const ESCROW_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "_seller", "type": "address" },
      { "internalType": "address", "name": "_mediator", "type": "address" }
    ],
    "name": "createEscrow",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "_escrowId", "type": "uint256" },
      { "internalType": "bytes32", "name": "_r", "type": "bytes32" },
      { "internalType": "bytes32", "name": "_s", "type": "bytes32" }
    ],
    "name": "releaseFunds",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
];