// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title MediatorPool
 * @dev Quản lý danh sách trọng tài tích hợp Chainlink VRF để chọn ngẫu nhiên tuyệt đối.
 */
contract MediatorPool is 
    VRFConsumerBaseV2Plus, 
    Initializable, 
    UUPSUpgradeable, 
    AccessControlUpgradeable, 
    PausableUpgradeable, 
    ReentrancyGuardTransient 
{
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint256 public constant COMMITTEE_SIZE = 5;
    uint256 public constant MIN_MEDIATORS = 5;
    uint256 public constant MAX_TIMEOUTS = 3;
    uint256 public constant MAINNET_STAKE = 0.01 ether;
    uint256 public constant TESTNET_STAKE = 0.001 ether;
    
    bool public isTestnet;
    
    // Risk detection events
    event SybilDetected(address indexed mediator, string reason);
    event RiskDetected(address indexed mediator, string reason);
    event ReputationUpdated(address indexed mediator, uint256 oldScore, uint256 newScore);

    /* ========== CẤU HÌNH CHAINLINK VRF ========== */
    // s_vrfCoordinator is inherited from VRFConsumerBaseV2Plus

    uint256 private s_subscriptionId;
    bytes32 private s_keyHash;
    uint32 private s_callbackGasLimit;
    uint16 private constant REQUEST_CONFIRMATIONS = 3; // Số block chờ xác nhận
    uint32 private constant NUM_WORDS = 5; // Cần 5 số random để chọn 5 mediators

    /* ========== CẤU TRÚC DỮ LIỆU MEDIATOR ========== */
    struct Mediator {
        address wallet;
        uint256 stakeAmount;
        bool isActive;
        uint256 timeoutCount;
        uint256 reputationScore; // 0-100
        uint256 totalVotes;
        uint256 successfulVotes;
    }

    address[] public mediatorsList;
    mapping(address => Mediator) public mediators;

    /* ========== TRẠNG THÁI YÊU CẦU RANDOM ========== */
    // Lưu lại requestId của VRF đang chờ -> để biết nó đang phục vụ cho Escrow nào
    struct RequestDetails {
        bytes32 escrowId;
        address buyer;
        address seller;
    }
    mapping(uint256 requestId => RequestDetails) public vrfRequests;
    uint256 public upgradeNonce;

    /* ========== EVENTS ========== */
    event MediatorRegistered(address indexed mediator, uint256 amount);
    event MediatorUnregistered(address indexed mediator, uint256 amount);
    event RandomnessRequested(uint256 requestId, bytes32 indexed escrowId);
    event RandomMediatorSelected(bytes32 indexed escrowId, address[] mediators);
    event MediatorSlashed(address indexed mediator, uint256 amount);

    /* ========== KHAI BÁO ========== */
    constructor(address _vrfCoordinator)
        VRFConsumerBaseV2Plus(_vrfCoordinator)
    {
        _disableInitializers();
    }
    
    function initialize(
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit
    ) public initializer {
        __AccessControl_init();
        __Pausable_init();
        
        s_subscriptionId = _subscriptionId;
        s_keyHash = _keyHash;
        s_callbackGasLimit = _callbackGasLimit;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        
        isTestnet = block.chainid == 11155111;
    }

    function initializeVrfConfig(address _vrfCoordinator) external reinitializer(2) onlyRole(ADMIN_ROLE) {
        require(_vrfCoordinator != address(0), "VRF coordinator cannot be zero");
        s_vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        emit CoordinatorSet(_vrfCoordinator);
    }

    function updateVrfCoordinator(address _vrfCoordinator) external onlyRole(ADMIN_ROLE) {
        require(_vrfCoordinator != address(0), "VRF coordinator cannot be zero");
        s_vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
        emit CoordinatorSet(_vrfCoordinator);
    }
    
    function updateCallbackGasLimit(uint32 _callbackGasLimit) external onlyRole(ADMIN_ROLE) {
        s_callbackGasLimit = _callbackGasLimit;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(ADMIN_ROLE) {}
    
    function getRequiredStake() public view returns (uint256) {
        return isTestnet ? TESTNET_STAKE : MAINNET_STAKE;
    }

    /* ========== ĐĂNG KÝ MEDIATOR ========== */
    function registerAsMediator() external payable whenNotPaused nonReentrant {
        require(msg.value >= getRequiredStake(), "Stake too low");
        require(!mediators[msg.sender].isActive, "Already registered");

        mediators[msg.sender] = Mediator(msg.sender, msg.value, true, 0, 50, 0, 0);
        mediatorsList.push(msg.sender);

        emit MediatorRegistered(msg.sender, msg.value);
    }
    
    function updateReputation(address mediator, uint256 newScore) external onlyRole(ADMIN_ROLE) {
        require(newScore <= 100, "Score must be 0-100");
        uint256 oldScore = mediators[mediator].reputationScore;
        mediators[mediator].reputationScore = newScore;
        emit ReputationUpdated(mediator, oldScore, newScore);
    }

    function unregister() external nonReentrant {
        require(mediators[msg.sender].isActive, "Not active");
        _removeFromArray(msg.sender);

        uint256 amount = mediators[msg.sender].stakeAmount;
        delete mediators[msg.sender];

        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit MediatorUnregistered(msg.sender, amount);
    }

    /* ========== YÊU CẦU RANDOM TỪ VRF ========== */
    /**
     * @dev Hàm này được gọi khi Escrow cần chọn ngẫu nhiên 5 Mediators.
     * Nó sẽ tốn 1 lượng LINK để trả phí cho Chainlink.
     */
    function requestRandomMediator(bytes32 escrowId, address buyer, address seller) external whenNotPaused nonReentrant {
        require(mediatorsList.length >= MIN_MEDIATORS, "Not enough mediators");
        require(buyer != seller, "Buyer and seller must be different");

        // Gửi yêu cầu lên Chainlink VRF v2.5
        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: s_keyHash,
                subId: s_subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: s_callbackGasLimit,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: false})
                )
            })
        );

        vrfRequests[requestId] = RequestDetails(escrowId, buyer, seller);

        emit RandomnessRequested(requestId, escrowId);
    }

    /* ========== HÀM GỌI LẠI TỪ VRF (Fulfill) ========== */
    /**
     * @dev Hàm này được Chainlink Node gọi lại 1 cách tự động và an toàn.
     * randomWords chứa 5 số ngẫu nhiên để chọn 5 mediators.
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) internal override {
        // Lấy chi tiết request
        RequestDetails memory details = vrfRequests[requestId];
        require(details.escrowId != bytes32(0), "Invalid request");

        // Xóa request đã xử lý để tiết kiệm storage
        delete vrfRequests[requestId];

        // Kiểm tra đủ số random words
        require(randomWords.length >= COMMITTEE_SIZE, "Insufficient random words");

        // Xây dựng danh sách mediator đủ điều kiện (loại buyer/seller)
        address[] memory eligibleMediators = new address[](mediatorsList.length);
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < mediatorsList.length; i++) {
            address m = mediatorsList[i];
            if (m != details.buyer && m != details.seller && mediators[m].isActive) {
                eligibleMediators[eligibleCount] = m;
                eligibleCount++;
            }
        }
        require(eligibleCount >= COMMITTEE_SIZE, "Not enough eligible mediators");

        // Chọn 5 mediators ngẫu nhiên không trùng lặp từ danh sách đủ điều kiện
        address[] memory selectedMediators = new address[](COMMITTEE_SIZE);
        bool[] memory selected = new bool[](eligibleCount);
        
        for (uint256 i = 0; i < COMMITTEE_SIZE; i++) {
            uint256 randomNumber = randomWords[i];
            uint256 index = randomNumber % eligibleCount;
            
            uint256 attempts = 0;
            // Nếu mediator đã được chọn, thử index tiếp theo
            while (selected[index] && attempts < eligibleCount) {
                index = (index + 1) % eligibleCount;
                attempts++;
            }
            require(attempts < eligibleCount, "Selection collision exceeded");
            
            selected[index] = true;
            selectedMediators[i] = eligibleMediators[index];
            
            // Optional: Detect low reputation for monitoring
            if (mediators[selectedMediators[i]].reputationScore < 30) {
                emit RiskDetected(selectedMediators[i], "Low reputation");
            }
        }

        // Emit sự kiện để Backend/WebSocket bắt được
        emit RandomMediatorSelected(details.escrowId, selectedMediators);
    }

    /* ========== ADMIN MEDIATOR MANAGEMENT ========== */
    function adminUnregisterMediator(address mediator) external onlyRole(ADMIN_ROLE) {
        require(mediators[mediator].isActive, "Mediator not active");
        
        _removeFromArray(mediator);
        delete mediators[mediator];

        emit MediatorUnregistered(mediator, 0);
    }

    /* ========== XỬ LÝ TIMEOUT ========== */
    function slashForTimeout(address _mediator) external onlyRole(ADMIN_ROLE) nonReentrant {
        require(mediators[_mediator].isActive, "Not active");

        Mediator storage m = mediators[_mediator];
        m.timeoutCount += 1;

        if (m.timeoutCount >= MAX_TIMEOUTS) {
            _removeFromArray(_mediator);
            uint256 penalty = m.stakeAmount;
            delete mediators[_mediator];

            (bool success, ) = msg.sender.call{value: penalty}("");
            require(success, "Slash failed");

            emit MediatorSlashed(_mediator, penalty);
        }
    }

    /* ========== HÀM HỖ TRỢ ========== */
    function _removeFromArray(address addr) internal {
        uint256 length = mediatorsList.length;
        for (uint256 i = 0; i < length; i++) {
            if (mediatorsList[i] == addr) {
                mediatorsList[i] = mediatorsList[length - 1];
                mediatorsList.pop();
                break;
            }
        }
    }

    function getAllMediators() external view returns (Mediator[] memory) {
        Mediator[] memory list = new Mediator[](mediatorsList.length);
        for (uint256 i = 0; i < mediatorsList.length; i++) {
            list[i] = mediators[mediatorsList[i]];
        }
        return list;
    }

    // Hàm test helper để mô phỏng VRF callback (chỉ dùng trong test)
    function testFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external {
        // Copy memory array to calldata-compatible format for internal call
        this.fulfillRandomWordsProxy(requestId, randomWords);
    }

    // Internal proxy to handle the calldata requirement for testing
    function fulfillRandomWordsProxy(uint256 requestId, uint256[] calldata randomWords) external {
        fulfillRandomWords(requestId, randomWords);
    }

    receive() external payable {}
}