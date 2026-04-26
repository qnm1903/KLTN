// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/VRFConsumerBaseV2.sol";
import "@chainlink/contracts/src/v0.8/interfaces/VRFCoordinatorV2Interface.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title MediatorPool
 * @dev Quản lý danh sách trọng tài tích hợp Chainlink VRF để chọn ngẫu nhiên tuyệt đối.
 */
contract MediatorPool is VRFConsumerBaseV2, Ownable, ReentrancyGuard {

    /* ========== CẤU HÌNH CHAINLINK VRF ========== */
    VRFCoordinatorV2Interface private immutable COORDINATOR;

    // Các thông số này phụ thuộc vào mạng lưới bạn deploy (Sepolia, Base, Polygon...)
    // Ví dụ Sepolia:
    // uint64 s_subscriptionId = 123;
    // bytes32 s_keyHash = 0x474e34a077df58807dbe9c96d3c009b23b3c6d0cce433e59bbf5b34f823bc56c;
    // uint32 callbackGasLimit = 100000;

    uint64 private immutable s_subscriptionId;
    bytes32 private immutable s_keyHash;
    uint32 private immutable s_callbackGasLimit;
    uint16 private constant REQUEST_CONFIRMATIONS = 3; // Số block chờ xác nhận
    uint32 private constant NUM_WORDS = 1; // Chỉ cần 1 số random

    /* ========== CẤU TRÚC DỮ LIỆU MEDIATOR ========== */
    struct Mediator {
        address wallet;
        uint256 stakeAmount;
        bool isActive;
        uint256 timeoutCount;
    }

    address[] public mediatorsList;
    mapping(address => Mediator) public mediators;

    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant MAX_TIMEOUTS = 3;

    /* ========== TRẠNG THÁI YÊU CẦU RANDOM ========== */
    // Lưu lại requestId của VRF đang chờ -> để biết nó đang phục vụ cho Escrow nào
    mapping(uint256 requestId => bytes32 escrowId) public vrfRequests;

    /* ========== EVENTS ========== */
    event MediatorRegistered(address indexed mediator, uint256 amount);
    event MediatorUnregistered(address indexed mediator, uint256 amount);
    event RandomnessRequested(uint256 requestId, bytes32 indexed escrowId);
    event RandomMediatorSelected(bytes32 indexed escrowId, address indexed mediator);
    event MediatorSlashed(address indexed mediator, uint256 amount);

    /* ========== KHAI BÁO ========== */
    constructor(
        address _vrfCoordinator,   // Địa chỉ VRF Coordinator của mạng
        uint64 _subscriptionId,    // ID Subscription đã tạo trên web Chainlink
        bytes32 _keyHash,          // KeyHash của mạng
        uint32 _callbackGasLimit   // Gas limit cho hàm fulfill
    )
        VRFConsumerBaseV2(_vrfCoordinator)
        Ownable(msg.sender)
    {
        COORDINATOR = VRFCoordinatorV2Interface(_vrfCoordinator);
        s_subscriptionId = _subscriptionId;
        s_keyHash = _keyHash;
        s_callbackGasLimit = _callbackGasLimit;
    }

    /* ========== ĐĂNG KÝ MEDIATOR ========== */
    function registerAsMediator() external payable nonReentrant {
        require(msg.value >= MIN_STAKE, "Stake too low");
        require(!mediators[msg.sender].isActive, "Already registered");

        mediators[msg.sender] = Mediator(msg.sender, msg.value, true, 0);
        mediatorsList.push(msg.sender);

        emit MediatorRegistered(msg.sender, msg.value);
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
     * @dev Hàm này được gọi khi Escrow cần chọn ngẫu nhiên 1 Mediator.
     * Nó sẽ tốn 1 lượng LINK để trả phí cho Chainlink.
     */
    function requestRandomMediator(bytes32 escrowId) external onlyOwner nonReentrant {
        require(mediatorsList.length > 0, "No mediators");

        // Gửi yêu cầu lên Chainlink
        uint256 requestId = COORDINATOR.requestRandomWords(
            s_keyHash,
            s_subscriptionId,
            REQUEST_CONFIRMATIONS,
            s_callbackGasLimit,
            NUM_WORDS
        );

        // Lưu lại requestId này để khi VRF gọi về ta biết nó đang phục vụ Escrow nào
        vrfRequests[requestId] = escrowId;

        emit RandomnessRequested(requestId, escrowId);
    }

    /* ========== HÀM GỌI LẠI TỪ VRF (Fulfill) ========== */
    /**
     * @dev Hàm này được Chainlink Node gọi lại 1 cách tự động và an toàn.
     * randomWords[0] chính là con số ngẫu nhiên tuyệt đối.
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] memory randomWords
    ) internal override {
        // Lấy ID Escrow tương ứng với request này
        bytes32 escrowId = vrfRequests[requestId];
        require(escrowId != bytes32(0), "Invalid request");

        // Xóa request đã xử lý để tiết kiệm storage
        delete vrfRequests[requestId];

        // Lấy số random từ Chainlink
        uint256 randomNumber = randomWords[0];

        // Tính toán index ngẫu nhiên trong Pool
        uint256 index = randomNumber % mediatorsList.length;
        address selectedMediator = mediatorsList[index];

        // Đảm bảo người này vẫn active
        require(mediators[selectedMediator].isActive, "Selected inactive");

        // ** TẠI ĐÂY LÀ ĐIỂM GIAO NHAU **
        // Emit sự kiện để Backend/WebSocket bắt được.
        // Backend sẽ lấy selectedMediator này để tiếp tục xử lý Escrow.
        emit RandomMediatorSelected(escrowId, selectedMediator);

        // Nếu bạn muốn tự động gọi thẳng vào EscrowFactory, bạn có thể gọi ở đây:
        // EscrowFactory(factoryAddress).createEscrow(escrowId, selectedMediator);
    }

    /* ========== XỬ LÝ TIMEOUT ========== */
    function slashForTimeout(address _mediator) external onlyOwner nonReentrant {
        require(mediators[_mediator].isActive, "Not active");

        Mediator storage m = mediators[_mediator];
        m.timeoutCount += 1;

        if (m.timeoutCount >= MAX_TIMEOUTS) {
            _removeFromArray(_mediator);
            uint256 penalty = m.stakeAmount;
            delete mediators[_mediator];

            (bool success, ) = owner().call{value: penalty}("");
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

    receive() external payable {}
}
