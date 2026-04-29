import express from 'express';
import { ethers } from 'ethers';
import { authMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = express.Router();

// ABI cho MediatorPool
const MEDIATOR_POOL_ABI = [
  'function registerAsMediator() external payable',
  'function unregister() external',
  'function requestRandomMediator(bytes32 escrowId, address buyer, address seller) external',
  'function getRequiredStake() external view returns (uint256)',
  'function mediators(address) external view returns (address wallet, uint256 stakeAmount, bool isActive, uint256 timeoutCount, uint256 reputationScore, uint256 totalVotes, uint256 successfulVotes)',
  'function mediatorsList(uint256) external view returns (address)',
  'function getAllMediators() external view returns (Mediator[])',
  'function isTestnet() external view returns (bool)',
  'event MediatorRegistered(address indexed mediator, uint256 amount)',
  'event MediatorUnregistered(address indexed mediator, uint256 amount)',
  'event RandomnessRequested(uint256 requestId, bytes32 indexed escrowId)',
  'event RandomMediatorSelected(bytes32 indexed escrowId, address[] mediators)',
  'event SybilDetected(address indexed mediator, string reason)',
  'event ReputationUpdated(address indexed mediator, uint256 oldScore, uint256 newScore)',
  'struct Mediator { address wallet; uint256 stakeAmount; bool isActive; uint256 timeoutCount; uint256 reputationScore; uint256 totalVotes; uint256 successfulVotes; }'
];

/**
 * @route   POST /api/mediator/register
 * @desc    Register as mediator on-chain
 * @access  Private (authenticated)
 */
router.post('/register', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { txHash } = req.body;

    if (!txHash) {
      return res.status(400).json({ error: 'Transaction hash required' });
    }

    // Verify transaction
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction failed or not found' });
    }

    // Check if user is already registered as mediator in DB
    const existingMediator = await prisma.user.findFirst({
      where: { 
        id: user.id,
        isMediator: true 
      }
    });

    if (existingMediator) {
      return res.status(400).json({ error: 'Already registered as mediator' });
    }

    // Update user as mediator
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isMediator: true,
        mediatorRegisteredAt: new Date(),
        walletAddress: user.walletAddress.toLowerCase()
      }
    });

    res.json({ 
      success: true, 
      message: 'Registered as mediator successfully',
      txHash 
    });
  } catch (error) {
    console.error('[Mediator Register Error]:', error);
    res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

/**
 * @route   POST /api/mediator/unregister
 * @desc    Unregister as mediator
 * @access  Private (authenticated)
 */
router.post('/unregister', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { txHash } = req.body;

    if (!txHash) {
      return res.status(400).json({ error: 'Transaction hash required' });
    }

    // Verify transaction
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt || receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction failed or not found' });
    }

    // Check if user is registered as mediator
    const mediator = await prisma.user.findFirst({
      where: { 
        id: user.id,
        isMediator: true 
      }
    });

    if (!mediator) {
      return res.status(400).json({ error: 'Not registered as mediator' });
    }

    // Update user - remove mediator status
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isMediator: false,
        mediatorStake: 0
      }
    });

    res.json({ 
      success: true, 
      message: 'Unregistered as mediator successfully',
      txHash 
    });
  } catch (error) {
    console.error('[Mediator Unregister Error]:', error);
    res.status(500).json({ error: error.message || 'Unregistration failed' });
  }
});

/**
 * @route   POST /api/mediator/request-random
 * @desc    Request random mediator selection for escrow, excluding buyer and seller
 * @access  Private (authenticated)
 */
router.post('/request-random', authMiddleware, async (req, res) => {
  try {
    const { escrowId, buyerAddress, sellerAddress } = req.body;

    if (!escrowId) {
      return res.status(400).json({ error: 'Escrow ID required' });
    }

    const mediatorPoolAddress = process.env.MEDIATOR_POOL_CONTRACT;
    if (!mediatorPoolAddress) {
      return res.status(500).json({ error: 'MediatorPool contract not configured' });
    }

    if (!process.env.PRIVATE_KEY || !process.env.RPC_URL) {
      return res.status(500).json({ error: 'Server wallet not configured' });
    }

    // Create signer directly from env (../lib/ethereum.js does not exist)
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const mediatorPool = new ethers.Contract(mediatorPoolAddress, MEDIATOR_POOL_ABI, signer);

    // Normalize addresses; fallback to empty if not provided (contract will revert if same)
    const buyer = buyerAddress ? ethers.getAddress(buyerAddress) : ethers.ZeroAddress;
    const seller = sellerAddress ? ethers.getAddress(sellerAddress) : ethers.ZeroAddress;

    // Request random mediators with buyer/seller exclusion
    const tx = await mediatorPool.requestRandomMediator(escrowId, buyer, seller);
    const receipt = await tx.wait();

    // Parse requestId from event
    const event = receipt.logs.find(log => {
      try {
        const parsed = mediatorPool.interface.parseLog(log);
        return parsed.name === 'RandomnessRequested';
      } catch (e) {
        return false;
      }
    });

    if (!event) {
      return res.status(500).json({ error: 'Randomness request event not found' });
    }

    const parsedEvent = mediatorPool.interface.parseLog(event);
    const requestId = parsedEvent.args.requestId;

    res.json({
      success: true,
      message: 'Random mediator selection requested',
      requestId: requestId.toString(),
      escrowId,
      buyerAddress: buyer,
      sellerAddress: seller,
      txHash: receipt.hash
    });
  } catch (error) {
    console.error('[Request Random Error]:', error);
    res.status(500).json({ error: error.message || 'Request failed' });
  }
});

/**
 * @route   GET /api/mediator/pool-status
 * @desc    Get pool statistics
 * @access  Public
 */
router.get('/pool-status', async (req, res) => {
  try {
    // Count mediators in DB
    const totalMediators = await prisma.user.count({
      where: { isMediator: true }
    });

    // Get required stake from contract
    let requiredStake = '0.01';
    try {
      const mediatorPoolAddress = process.env.MEDIATOR_POOL_CONTRACT;
      if (mediatorPoolAddress) {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const mediatorPool = new ethers.Contract(mediatorPoolAddress, MEDIATOR_POOL_ABI, provider);
        const stakeWei = await mediatorPool.getRequiredStake();
        requiredStake = ethers.formatEther(stakeWei);
      }
    } catch (e) {
      console.warn('Could not get required stake from contract:', e.message);
    }

    res.json({
      totalMediators,
      minRequired: 5,
      requiredStake: `${requiredStake} ETH`,
      canCreateEscrow: totalMediators >= 5
    });
  } catch (error) {
    console.error('[Pool Status Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/mediator/all
 * @desc    Get all mediators from contract
 * @access  Public
 */
router.get('/all', async (req, res) => {
  try {
    const mediatorPoolAddress = process.env.MEDIATOR_POOL_CONTRACT;
    if (!mediatorPoolAddress) {
      return res.status(500).json({ error: 'MediatorPool contract not configured' });
    }

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const mediatorPool = new ethers.Contract(mediatorPoolAddress, MEDIATOR_POOL_ABI, provider);

    const mediators = await mediatorPool.getAllMediators();

    const formattedMediators = mediators.map(m => ({
      wallet: m.wallet,
      stakeAmount: ethers.formatEther(m.stakeAmount),
      isActive: m.isActive,
      timeoutCount: Number(m.timeoutCount),
      reputationScore: Number(m.reputationScore),
      totalVotes: Number(m.totalVotes),
      successfulVotes: Number(m.successfulVotes)
    }));

    res.json({ mediators: formattedMediators });
  } catch (error) {
    console.error('[Get All Mediators Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @route   GET /api/mediator/:address
 * @desc    Get mediator info
 * @access  Public
 */
router.get('/:address', async (req, res) => {
  try {
    const { address } = req.params;

    const mediatorPoolAddress = process.env.MEDIATOR_POOL_CONTRACT;
    if (!mediatorPoolAddress) {
      return res.status(500).json({ error: 'MediatorPool contract not configured' });
    }

    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const mediatorPool = new ethers.Contract(mediatorPoolAddress, MEDIATOR_POOL_ABI, provider);

    const mediator = await mediatorPool.mediators(address);

    if (!mediator.isActive) {
      return res.status(404).json({ error: 'Mediator not found' });
    }

    res.json({
      wallet: mediator.wallet,
      stakeAmount: ethers.formatEther(mediator.stakeAmount),
      isActive: mediator.isActive,
      timeoutCount: Number(mediator.timeoutCount),
      reputationScore: Number(mediator.reputationScore),
      totalVotes: Number(mediator.totalVotes),
      successfulVotes: Number(mediator.successfulVotes)
    });
  } catch (error) {
    console.error('[Get Mediator Error]:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;